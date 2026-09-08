import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { normalizeMediaUrl } from './media-link-extractor.js';
import { resolveSharedUrl } from './share-resolver.js';

const MAX_MEDIA_BYTES = 256 * 1024 * 1024;

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function runCommand(command, args, { timeoutMs = 120_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('媒体下载超时'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 16 * 1024) stderr = stderr.slice(-16 * 1024);
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`yt-dlp 下载失败（${String(stderr).trim().slice(-500)}）`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parsePrintedJson(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/gu).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* yt-dlp may print progress text around the JSON line */ }
  }
  return {};
}

async function runYtDlp(url, {
  command = 'yt-dlp',
  timeoutMs = 120_000,
  outputDirectory,
} = {}) {
  await mkdir(outputDirectory, { recursive: true });
  const basename = `${Date.now()}-${randomBytes(8).toString('hex')}`;
  const outputTemplate = path.join(outputDirectory, `${basename}.%(ext)s`);
  const { stdout } = await runCommand(command, [
    '--no-playlist', '--no-warnings', '--no-progress',
    '--format', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
    '--merge-output-format', 'mp4', '--recode-video', 'mp4',
    '--print', 'after_move:filepath', '--print-json',
    '--output', outputTemplate, url,
  ], { timeoutMs, cwd: outputDirectory });

  const info = parsePrintedJson(stdout);
  const printedPath = String(stdout).split(/\r?\n/gu)
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith(outputDirectory) && line.endsWith('.mp4'));
  const filePath = printedPath || path.join(outputDirectory, `${basename}.mp4`);
  const fileInfo = await stat(filePath).catch(() => null);
  if (!fileInfo?.isFile() || fileInfo.size <= 0) {
    throw new Error('yt-dlp 未生成可发送的 MP4 文件');
  }
  if (fileInfo.size > MAX_MEDIA_BYTES) {
    await unlink(filePath).catch(() => {});
    throw new Error('视频文件超过 256 MiB，已跳过发送');
  }
  return {
    filePath,
    title: String(info.title || '').slice(0, 200),
    duration: positive(info.duration),
    extractor: String(info.extractor_key || info.extractor || '').slice(0, 80),
    downloadBytes: fileInfo.size,
    outputBytes: fileInfo.size,
  };
}

async function extractHtmlVideo(url, timeoutMs, outputDirectory) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QQMediaResolver/1.0)' },
    });
    if (!response.ok) throw new Error(`页面返回 HTTP ${response.status}`);
    const html = (await response.text()).slice(0, 2 * 1024 * 1024);
    const matches = [
      ...html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:video|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/giu),
      ...html.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video|twitter:player:stream)["']/giu),
      ...html.matchAll(/"(?:video_url|videoUrl|play_url|playUrl|contentUrl)"\s*:\s*"(https?:\\?\/\\?\/[^"\\]+)/giu),
    ];
    for (const match of matches) {
      const candidate = normalizeMediaUrl(String(match[1]).replaceAll('\\/', '/'));
      if (!candidate) continue;
      const mediaResponse = await fetch(candidate, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QQMediaResolver/1.0)' },
      });
      if (!mediaResponse.ok || !mediaResponse.body) continue;
      await mkdir(outputDirectory, { recursive: true });
      const filePath = path.join(outputDirectory, `${Date.now()}-${randomBytes(8).toString('hex')}.mp4`);
      await pipeline(mediaResponse.body, createWriteStream(filePath));
      const fileInfo = await stat(filePath).catch(() => null);
      if (fileInfo?.isFile() && fileInfo.size > 0 && fileInfo.size <= MAX_MEDIA_BYTES) {
        return { filePath, title: '', duration: 0, extractor: 'html-meta', downloadBytes: fileInfo.size, outputBytes: fileInfo.size };
      }
      await unlink(filePath).catch(() => {});
    }
    throw new Error('页面未发现可下载的视频地址');
  } finally {
    clearTimeout(timer);
  }
}

export class MediaResolver {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.command = options.command || 'yt-dlp';
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.cacheTtlMs = Math.max(0, Number(options.cacheTtlMs ?? 10 * 60 * 1000));
    this.cacheDirectory = options.cacheDirectory || path.resolve('data/media-cache');
    this.publicBaseUrl = String(options.publicBaseUrl || 'http://qq-bot:8787').replace(/\/+$/u, '');
    this.maxConcurrent = Math.max(1, Number(options.maxConcurrent ?? 2));
    this.publicResolverEnabled = options.publicResolverEnabled !== false;
    this.cache = new Map();
    this.mediaFiles = new Map();
    this.inflight = new Map();
    this.active = 0;
    this.waiters = [];
    mkdir(this.cacheDirectory, { recursive: true }).catch(() => {});
  }

  async acquireSlot() {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  releaseSlot() {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }

  async cleanupExpired() {
    const now = Date.now();
    for (const [id, item] of this.mediaFiles) {
      if (item.expiresAt > now) continue;
      this.mediaFiles.delete(id);
      await unlink(item.filePath).catch(() => {});
    }
    const entries = await readdir(this.cacheDirectory).catch(() => []);
    for (const entry of entries) {
      const filePath = path.join(this.cacheDirectory, entry);
      const info = await stat(filePath).catch(() => null);
      if (info?.isFile() && now - info.mtimeMs > this.cacheTtlMs * 2) {
        await unlink(filePath).catch(() => {});
      }
    }
  }

  registerMedia(value) {
    const id = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + this.cacheTtlMs;
    this.mediaFiles.set(id, { filePath: value.filePath, expiresAt, size: value.outputBytes || 0 });
    return {
      ...value,
      mediaId: id,
      url: `${this.publicBaseUrl}/v1/qq/media/${id}`,
    };
  }

  async getMediaFile(mediaId) {
    const normalizedId = String(mediaId || '');
    const item = this.mediaFiles.get(normalizedId);
    if (!item || item.expiresAt <= Date.now()) {
      if (item) {
        this.mediaFiles.delete(normalizedId);
        await unlink(item.filePath).catch(() => {});
      }
      return null;
    }
    const info = await stat(item.filePath).catch(() => null);
    return info?.isFile() ? { ...item, size: info.size } : null;
  }

  async resolve(candidate) {
    if (!this.enabled) throw new Error('媒体解析未启用');
    const key = String(candidate?.url || '').trim();
    if (!key) throw new Error('媒体地址为空');
    await this.cleanupExpired();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) this.cache.delete(key);
    if (this.inflight.has(key)) return this.inflight.get(key);

    const task = (async () => {
      await this.acquireSlot();
      try {
        let sourceKey = key;
        let publicMetadata = {};
        if (this.publicResolverEnabled) {
          try {
            publicMetadata = await resolveSharedUrl(key, {
              timeoutMs: Math.min(this.timeoutMs, 15_000),
            });
            if (publicMetadata.mediaUrl) sourceKey = publicMetadata.mediaUrl;
          } catch {
            // Public metadata is an optimization. yt-dlp remains the fallback.
          }
        }
        let downloaded;
        try {
          downloaded = await runYtDlp(sourceKey, {
            command: this.command,
            timeoutMs: this.timeoutMs,
            outputDirectory: this.cacheDirectory,
          });
        } catch (ytError) {
          try {
            downloaded = await extractHtmlVideo(sourceKey, this.timeoutMs, this.cacheDirectory);
          } catch (htmlError) {
            throw new Error(`${ytError.message}；网页兜底：${htmlError.message}`);
          }
        }
        downloaded.title ||= publicMetadata.title || '';
        return this.registerMedia(downloaded);
      } finally {
        this.releaseSlot();
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, task);
    const value = await task;
    if (this.cacheTtlMs > 0) {
      this.cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs });
      if (this.cache.size > 500) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
    }
    return value;
  }
}
