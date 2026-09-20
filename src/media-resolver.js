import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { normalizeMediaUrl } from './media-link-extractor.js';
import { resolveSharedUrl } from './share-resolver.js';
import { warmRemoteMedia } from './media-stream-proxy.js';
import { isRemovedError, removedError } from './media-removed.js';
import {
  MAX_MEDIA_BYTES, MAX_MEDIA_EXTRACTION_MS,
  isMediaExtractionTimeoutError, isMediaTooLargeError,
  mediaExtractionTimeoutError, mediaTooLargeError,
} from './media-limits.js';
import {
  extractBilibiliVideoId, extractBilibiliVideoIdFromToolOutput, resolveBilibiliMedia,
  normalizeBilibiliSource, isBilibiliPartError,
} from './bilibili-provider.js';

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

async function raceExtraction(task, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(mediaExtractionTimeoutError()), timeoutMs);
    timer.unref?.();
    Promise.resolve(task).then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// 只保留有值的字段，用于把权威来源覆盖到兜底来源上而不抹掉后者已有的内容。
export function pruneEmpty(source) {
  const result = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && !value.length) continue;
    result[key] = value;
  }
  return result;
}

export function normalizeDownloadSource(value) {
  const normalized = normalizeMediaUrl(value);
  if (!normalized) return '';
  return normalizeBilibiliSource(normalized);
}

function runCommand(command, args, { timeoutMs = 120_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(mediaExtractionTimeoutError());
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
        const error = new Error(`yt-dlp 下载失败（${String(stderr).trim().slice(-500)}）`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function limitedFileTransform() {
  let bytes = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_MEDIA_BYTES) {
        callback(mediaTooLargeError(bytes));
        return;
      }
      callback(null, chunk, encoding);
    },
  });
}

function contentLength(response) {
  const direct = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const range = response.headers.get('content-range')?.match(/\/([0-9]+)$/u);
  return range ? Number(range[1]) : 0;
}

async function probeRemoteSize(value, timeoutMs = 8_000) {
  const known = Number(value?.size || 0);
  if (known > 0) return known;
  const url = String(value?.mediaUrl || '').trim();
  if (!url) return 0;
  const headers = value.requestHeaders || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    try {
      const head = await fetch(url, { method: 'HEAD', headers, signal: controller.signal });
      const size = head.ok ? contentLength(head) : 0;
      await head.body?.cancel().catch(() => {});
      if (size > 0) return size;
    } catch { /* Some signed CDNs reject HEAD; use a one-byte range below. */ }
    const ranged = await fetch(url, {
      headers: { ...headers, Range: 'bytes=0-0' }, signal: controller.signal,
    });
    const size = ranged.ok ? contentLength(ranged) : 0;
    await ranged.body?.cancel().catch(() => {});
    return size;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupYtDlpOutputs(outputDirectory, basename) {
  const entries = await readdir(outputDirectory).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.startsWith(`${basename}.`))
    .map((entry) => unlink(path.join(outputDirectory, entry)).catch(() => {})));
}

async function probeBilibiliShortLink(url, { command, timeoutMs }) {
  try {
    const output = await runCommand(command, [
      '--skip-download', '--no-playlist', '--no-warnings',
      '--print', 'id', '--print', 'webpage_url', url,
    ], { timeoutMs });
    return extractBilibiliVideoIdFromToolOutput(`${output.stdout}\n${output.stderr}`);
  } catch (error) {
    if (isBilibiliPartError(error)) throw error;
    return extractBilibiliVideoIdFromToolOutput(`${error.stdout || ''}\n${error.stderr || ''}`);
  }
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

export async function runYtDlp(url, {
  command = 'yt-dlp',
  timeoutMs = 120_000,
  outputDirectory,
  cookiesFile = '',
  cookie = '',
} = {}) {
  await mkdir(outputDirectory, { recursive: true });
  const basename = `${Date.now()}-${randomBytes(8).toString('hex')}`;
  const outputTemplate = path.join(outputDirectory, `${basename}.%(ext)s`);
  const args = [
    '--no-playlist', '--no-warnings', '--no-progress',
    '--format', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
    '--merge-output-format', 'mp4', '--recode-video', 'mp4',
    '--print', 'after_move:filepath', '--print-json',
    '--output', outputTemplate,
  ];
  let normalizedCookiesFile = '';
  if (cookiesFile) {
    let rawCookies = await readFile(cookiesFile, 'utf8');
    if (/^\s*[\[{]/u.test(rawCookies)) {
      const parsed = JSON.parse(rawCookies);
      const entries = Array.isArray(parsed) ? parsed : (parsed.cookies || []);
      const lines = ['# Netscape HTTP Cookie File'];
      for (const item of entries) {
        const domain = String(item.domain || item.host || '.douyin.com');
        const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
        const pathValue = String(item.path || '/');
        const secure = item.secure ? 'TRUE' : 'FALSE';
        const expiry = Number(item.expirationDate || item.expires || 0) || 0;
        const name = String(item.name || '');
        const value = String(item.value || '');
        if (name) lines.push([domain, includeSubdomains, pathValue, secure, expiry, name, value].join('\t'));
      }
      rawCookies = `${lines.join('\n')}\n`;
    }
    // yt-dlp writes the cookie jar on exit. Never hand it a read-only secret
    // mount or share one writable jar between concurrent downloads.
    normalizedCookiesFile = path.join(outputDirectory, `.${basename}.cookies.txt`);
    await writeFile(normalizedCookiesFile, rawCookies, { mode: 0o600, flag: 'wx' });
  }
  if (normalizedCookiesFile) args.push('--cookies', normalizedCookiesFile);
  if (cookie) args.push('--add-header', `Cookie: ${cookie}`);
  args.push(url);
  let stdout;
  let succeeded = false;
  try {
    ({ stdout } = await runCommand(command, args, { timeoutMs, cwd: outputDirectory }));
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
      throw mediaTooLargeError(fileInfo.size);
    }
    succeeded = true;
    return {
      filePath,
      title: String(info.title || '').slice(0, 200),
      duration: positive(info.duration),
      extractor: String(info.extractor_key || info.extractor || '').slice(0, 80),
      downloadBytes: fileInfo.size,
      outputBytes: fileInfo.size,
    };
  } finally {
    if (normalizedCookiesFile) await unlink(normalizedCookiesFile).catch(() => {});
    if (!succeeded) await cleanupYtDlpOutputs(outputDirectory, basename);
  }
}

async function extractHtmlVideo(url, timeoutMs, outputDirectory) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(mediaExtractionTimeoutError()), timeoutMs);
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
      const declaredSize = await probeRemoteSize({ mediaUrl: candidate }, 2_000);
      if (declaredSize > MAX_MEDIA_BYTES) throw mediaTooLargeError(declaredSize);
      const mediaResponse = await fetch(candidate, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QQMediaResolver/1.0)' },
      });
      if (!mediaResponse.ok || !mediaResponse.body) continue;
      await mkdir(outputDirectory, { recursive: true });
      const filePath = path.join(outputDirectory, `${Date.now()}-${randomBytes(8).toString('hex')}.mp4`);
      try {
        await pipeline(mediaResponse.body, limitedFileTransform(), createWriteStream(filePath));
      } catch (error) {
        await unlink(filePath).catch(() => {});
        throw error;
      }
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

async function downloadDirectMedia(value, timeoutMs, outputDirectory) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(mediaExtractionTimeoutError()), timeoutMs);
  const signal = value.signal
    ? AbortSignal.any([controller.signal, value.signal])
    : controller.signal;
  let filePath = '';
  try {
    const response = await fetch(value.mediaUrl, {
      signal,
      headers: value.requestHeaders || {},
    });
    if (!response.ok || !response.body) throw new Error(`视频流返回 HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAX_MEDIA_BYTES) throw mediaTooLargeError(declaredSize);
    await mkdir(outputDirectory, { recursive: true });
    filePath = path.join(outputDirectory, `${Date.now()}-${randomBytes(8).toString('hex')}.mp4`);
    await pipeline(response.body, limitedFileTransform(), createWriteStream(filePath));
    const info = await stat(filePath);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_MEDIA_BYTES) {
      if (info?.size > MAX_MEDIA_BYTES) throw mediaTooLargeError(info.size);
      throw new Error('下载的视频文件为空');
    }
    return {
      filePath, title: value.title || '', duration: positive(value.duration),
      extractor: 'bilibili-public-api', downloadBytes: info.size, outputBytes: info.size,
    };
  } catch (error) {
    if (filePath) await unlink(filePath).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class MediaResolver {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.command = options.command || 'yt-dlp';
    this.cookiesFile = String(options.cookiesFile || '').trim();
    this.cookie = String(options.cookie || '').trim();
    this.timeoutMs = options.timeoutMs ?? 120_000;
    // A configured provider/download timeout must never hold a media slot for
    // longer than the user-facing eight-minute extraction deadline.
    this.timeoutMs = Math.min(Math.max(1_000, Number(this.timeoutMs) || 120_000), MAX_MEDIA_EXTRACTION_MS);
    this.maxExtractionMs = MAX_MEDIA_EXTRACTION_MS;
    this.cacheTtlMs = Math.max(0, Number(options.cacheTtlMs ?? 10 * 60 * 1000));
    this.cacheDirectory = options.cacheDirectory || path.join(os.tmpdir(), 'longtu-media-cache');
    this.maxCacheBytes = Math.max(0, Number(options.maxCacheBytes ?? 512 * 1024 * 1024));
    this.publicBaseUrl = String(options.publicBaseUrl || 'http://qq-bot:8787').replace(/\/+$/u, '');
    this.maxConcurrent = Math.max(1, Number(options.maxConcurrent ?? 2));
    this.publicResolverEnabled = options.publicResolverEnabled !== false;
    this.providerResolver = typeof options.providerResolver === 'function'
      ? options.providerResolver
      : null;
    this.logger = options.logger || console;
    this.cache = new Map();
    this.mediaFiles = new Map();
    this.inflight = new Map();
    this.active = 0;
    this.waiters = [];
    mkdir(this.cacheDirectory, { recursive: true })
      .then(() => this.cleanupExpired())
      .catch(() => {});
    const cleanupIntervalMs = Math.max(30_000, Math.min(this.cacheTtlMs || 60_000, 60_000));
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired().catch((error) => {
        this.logger.warn(`媒体临时缓存清理失败：${error.message}`);
      });
    }, cleanupIntervalMs);
    this.cleanupTimer.unref?.();
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
      if (item.filePath) await unlink(item.filePath).catch(() => {});
    }
    const entries = await readdir(this.cacheDirectory).catch(() => []);
    const files = [];
    for (const entry of entries) {
      const filePath = path.join(this.cacheDirectory, entry);
      const info = await stat(filePath).catch(() => null);
      if (!info?.isFile()) continue;
      if (now - info.mtimeMs > this.cacheTtlMs) {
        await unlink(filePath).catch(() => {});
      } else {
        files.push({ filePath, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
    if (this.maxCacheBytes > 0) {
      let totalBytes = files.reduce((sum, item) => sum + item.size, 0);
      const protectedPaths = new Set(
        [...this.mediaFiles.values()]
          .filter((item) => item.expiresAt > now)
          .map((item) => item.filePath),
      );
      for (const item of files.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
        if (totalBytes <= this.maxCacheBytes) break;
        if (protectedPaths.has(item.filePath)) continue;
        await unlink(item.filePath).catch(() => {});
        totalBytes -= item.size;
      }
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    for (const item of this.mediaFiles.values()) item.prefetchController?.abort();
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

  registerRemoteMedia(value) {
    if (positive(value.size) > MAX_MEDIA_BYTES) throw mediaTooLargeError(value.size);
    const id = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + this.cacheTtlMs;
    const item = {
      remoteUrl: value.mediaUrl,
      backupUrls: value.backupMediaUrls || [],
      requestHeaders: value.requestHeaders || {},
      expiresAt,
      size: positive(value.size),
    };
    this.mediaFiles.set(id, item);
    // Download in the background while the share card is rendered. The proxy
    // will await this promise and stream the completed local file to NapCat.
    item.prefetchController = new AbortController();
    item.prefetchPromise = downloadDirectMedia({
      mediaUrl: value.mediaUrl, requestHeaders: value.requestHeaders || {},
      signal: item.prefetchController.signal,
    }, this.timeoutMs, this.cacheDirectory)
      .then((downloaded) => {
        item.filePath = downloaded.filePath;
        item.size = downloaded.outputBytes;
        item.remoteUrl = '';
        item.backupUrls = [];
        this.logger.info(`视频后台预下载完成：bytes=${item.size}`);
        return item;
      })
      .catch((error) => {
        this.logger.warn(`视频后台预下载失败，回退流式代理：${error.message}`);
        return item;
      });
    // Start DNS/TLS/CDN negotiation immediately; card rendering can overlap
    // with this warm-up before QQ requests the proxy URL.
    // The proxy races all signed CDN candidates on the first request. Avoid a
    // separate warm request here: it consumes a connection and can compete
    // with NapCat's first range request instead of reducing latency.
    return {
      url: `${this.publicBaseUrl}/v1/qq/media/${id}`,
      mediaId: id,
      title: value.title || '',
      coverUrl: value.coverUrl || '',
      author: value.author || '',
      avatarUrl: value.avatarUrl || '',
      provider: value.provider || '',
      tags: value.tags || [],
      images: value.images || [],
      publishedAt: positive(value.publishedAt),
      description: value.description || '',
      duration: positive(value.duration),
      ...(value.page ? { page: value.page, cid: value.cid } : {}),
      extractor: value.extractor || 'remote-stream-proxy',
      downloadBytes: 0,
      outputBytes: positive(value.size),
      quality: positive(value.quality),
      streamed: true,
    };
  }

  async rejectIfTooLarge(value) {
    try {
      const size = await probeRemoteSize(value, 2_000);
      if (size > MAX_MEDIA_BYTES) throw mediaTooLargeError(size);
      return size;
    } catch (error) {
      if (isMediaTooLargeError(error)) error.mediaMetadata = value;
      throw error;
    }
  }

  async getMediaFile(mediaId) {
    const normalizedId = String(mediaId || '');
    const item = this.mediaFiles.get(normalizedId);
    if (!item || item.expiresAt <= Date.now()) {
      if (item) {
        this.mediaFiles.delete(normalizedId);
        if (item.filePath) await unlink(item.filePath).catch(() => {});
      }
      return null;
    }
    // The prefetch is an optimization only. Never make NapCat wait for a full
    // remote download: return the signed stream after a short head start and
    // let the proxy race the CDN while the local copy continues in background.
    if (item.prefetchPromise) {
      await Promise.race([
        item.prefetchPromise,
        new Promise((resolve) => setTimeout(resolve, Math.min(500, this.timeoutMs))),
      ]);
    }
    if (item.filePath) {
      const info = await stat(item.filePath).catch(() => null);
      if (info?.isFile()) return { ...item, size: info.size };
    }
    if (item.remoteUrl) return { ...item, remote: true };
    const info = await stat(item.filePath).catch(() => null);
    return info?.isFile() ? { ...item, size: info.size } : null;
  }

  warm(mediaId) {
    const item = this.mediaFiles.get(String(mediaId || ''));
    if (!item?.remoteUrl) return;
    warmRemoteMedia(item, { logger: this.logger }).catch(() => {});
  }

  async resolve(candidate) {
    if (!this.enabled) throw new Error('媒体解析未启用');
    // Share links carry per-user tracking parameters; normalize before cache
    // lookup so the same media is not resolved once per group/share URL.
    const rawKey = String(candidate?.url || '').trim();
    const key = normalizeDownloadSource(rawKey) || rawKey;
    if (!key) throw new Error('媒体地址为空');
    await this.cleanupExpired();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      // Media validity is independent of optional card metadata. Reuse the
      // parsed video/gallery across groups even when an author/cover is absent.
      return cached.value;
    }
    if (cached) this.cache.delete(key);
    if (this.inflight.has(key)) return this.inflight.get(key);

    const task = (async () => {
      await this.acquireSlot();
      const deadline = Date.now() + this.maxExtractionMs;
      const remainingTimeout = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw mediaExtractionTimeoutError();
        return Math.min(this.timeoutMs, remaining);
      };
      try {
        let sourceKey = normalizeDownloadSource(key) || key;
        let publicMetadata = {};
        if (this.providerResolver) {
          try {
            const provided = await raceExtraction(this.providerResolver({
              url: key,
              platform: candidate?.provider || 'unknown',
            }), remainingTimeout());
            if (provided?.mediaUrl) {
              let title = provided.title || '';
              let coverUrl = provided.coverUrl || '';
              let cardMetadata = provided;
              if ((!title || !coverUrl) && candidate?.provider === 'xiaohongshu') {
                try {
                  const fallback = await resolveSharedUrl(key, { timeoutMs: Math.min(remainingTimeout(), 5_000) });
                  title ||= fallback.title || '';
                  coverUrl ||= fallback.coverUrl || '';
                  cardMetadata = { ...fallback, ...provided,
                    author: provided.author || fallback.author || '',
                    avatarUrl: provided.avatarUrl || fallback.avatarUrl || '',
                    description: provided.description || fallback.description || '',
                    tags: provided.tags?.length ? provided.tags : (fallback.tags || []),
                  };
                } catch { /* provider video remains usable without card metadata */ }
              }
              const directMedia = {
                mediaUrl: provided.mediaUrl,
                title, coverUrl: coverUrl || (provided.images && provided.images[0]) || '',
                author: cardMetadata.author || '', avatarUrl: cardMetadata.avatarUrl || '',
                description: cardMetadata.description || '', tags: cardMetadata.tags || [],
                images: cardMetadata.images || [], provider: candidate?.provider || '',
                duration: positive(provided.duration),
                size: positive(provided.size),
                extractor: 'provider-direct',
                downloadBytes: 0,
                outputBytes: 0,
                direct: true,
              };
              // QQ/NapCat cannot reliably download signed Douyin CDN URLs
              // directly and often gets HTTP 403. Keep the provider result
              // metadata, but send Douyin through our authenticated stream
              // proxy so the server fetches it with browser-like headers.
              await this.rejectIfTooLarge(directMedia);
              if (candidate?.provider === 'douyin') {
                directMedia.requestHeaders = {
                  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
                  Referer: 'https://www.douyin.com/',
                };
                return this.registerRemoteMedia(directMedia);
              }
              return { url: provided.mediaUrl, ...directMedia };
            }
            if (provided?.images?.length) {
              return {
                images: provided.images, title: provided.title || '',
                coverUrl: provided.images[0] || '',
                author: provided.author || '', avatarUrl: provided.avatarUrl || '', tags: provided.tags || [],
                description: provided.description || '', extractor: 'provider-gallery',
                downloadBytes: 0, outputBytes: 0, direct: true,
              };
            }
            // Provider 拿不到可播媒体但取到了页面元数据。留给下面的 yt-dlp
            // 路径补全卡片，否则同一条链接会时而完整、时而只剩一个标题。
            // 已删除的内容不走这里：那种页面也会残留零碎元数据，降级只会用
            // yt-dlp 的报错盖掉真正的原因。
            if (provided?.metadataOnly && isRemovedError(provided.title || '')) {
              throw new Error(removedError(candidate?.provider || '源站', String(provided.title)));
            }
            if (provided?.metadataOnly) {
              publicMetadata = {
                title: provided.title || '', coverUrl: provided.coverUrl || '',
                author: provided.author || '', avatarUrl: provided.avatarUrl || '',
                description: provided.description || '', tags: provided.tags || [],
              };
              this.logger.info(`媒体 Provider 只返回元数据，转 yt-dlp 取流：cover=${provided.coverUrl ? 'yes' : 'no'} author=${provided.author ? 'yes' : 'no'}`);
            }
          } catch (error) {
            // 源站已明确说内容没了：再降级到 yt-dlp 只会得到一句无关的
            // "Unsupported URL"，把真正的原因盖掉。直接把结论抛出去。
            if (isRemovedError(error)) {
              this.logger.info(`媒体源内容已删除，不再降级：${error.message}`);
              throw error;
            }
            if (isMediaTooLargeError(error) || isMediaExtractionTimeoutError(error)) throw error;
            this.logger.warn(`媒体 Provider 失败，尝试公开页面解析：${error.message}`);
          }
        }
        let bilibiliSource = null;
        try {
          bilibiliSource = extractBilibiliVideoId(sourceKey);
        } catch { /* sourceKey is validated later by the generic fallback */ }
        const isBilibili = Boolean(bilibiliSource || candidate?.provider === 'bilibili');
        if (isBilibili) {
          try {
            const bilibili = await resolveBilibiliMedia(sourceKey, {
              timeoutMs: Math.min(remainingTimeout(), 15_000),
              shortLinkIdResolver: (url) => probeBilibiliShortLink(url, {
                command: this.command, timeoutMs: Math.min(remainingTimeout(), 15_000),
              }),
            });
            if (bilibili?.mediaUrl) {
              await this.rejectIfTooLarge(bilibili);
              return this.registerRemoteMedia(bilibili);
            }
          } catch (error) {
            if (isBilibiliPartError(error)) throw error;
            if (isRemovedError(error)) {
              this.logger.info(`B站稿件已不可见，不再降级：${error.message}`);
              throw error;
            }
            if (isMediaTooLargeError(error) || isMediaExtractionTimeoutError(error)) throw error;
            // A short link may already have resolved to ?p=2. Keep that exact
            // part for yt-dlp even when the native playurl API fails.
            sourceKey = error.sourceUrl || sourceKey;
            publicMetadata = error.mediaMetadata || publicMetadata;
            this.logger.warn(`B站公开接口解析失败，转入通用兜底：${error.message}`);
          }
        }
        // Provider 已给出的元数据是权威的（登录态下的真实页面），公开页面
        // 只用来补它缺的字段，不能整份覆盖。
        const providerMetadata = publicMetadata;
        // Generic OG/video metadata does not identify a Bilibili part and can
        // point to P1 even on a P2 URL. Only the part-aware extractor may fall back.
        if (this.publicResolverEnabled && !isBilibili) {
          try {
            publicMetadata = await resolveSharedUrl(key, {
              timeoutMs: Math.min(remainingTimeout(), 15_000),
            });
            if (publicMetadata.mediaUrl) {
              await this.rejectIfTooLarge({ mediaUrl: publicMetadata.mediaUrl });
              sourceKey = normalizeDownloadSource(publicMetadata.mediaUrl)
                || publicMetadata.mediaUrl;
            } else if (publicMetadata.canonicalUrl) {
              sourceKey = normalizeDownloadSource(publicMetadata.canonicalUrl)
                || sourceKey;
            }
            if (publicMetadata.platform === 'xiaohongshu' && !publicMetadata.mediaUrl && publicMetadata.images?.length) {
              return {
                images: publicMetadata.images,
                title: publicMetadata.title || '',
                coverUrl: publicMetadata.images[0] || '',
                author: publicMetadata.author || '', avatarUrl: publicMetadata.avatarUrl || '', tags: publicMetadata.tags || [],
                description: publicMetadata.description || '',
                extractor: 'public-metadata-gallery', downloadBytes: 0,
                outputBytes: 0, direct: true,
              };
            }
          } catch (error) {
            if (isRemovedError(error)) {
              this.logger.info(`媒体源内容已删除，不再降级：${error.message}`);
              throw error;
            }
            if (isMediaTooLargeError(error) || isMediaExtractionTimeoutError(error)) throw error;
            if (candidate?.provider === 'xiaohongshu') {
              throw new Error(`小红书图文解析失败：公开页面不可访问（${error.message}）`);
            }
            // Other platforms may still use yt-dlp as a fallback.
          }
          // 公开页面拿到的字段只填 Provider 没给的那些。
          publicMetadata = { ...publicMetadata, ...pruneEmpty(providerMetadata) };
        }
        // 小红书图文笔记没有视频流时，不应再交给 yt-dlp 当视频处理。
        // 没有 Provider 且公开页面没有图片元数据，就明确失败并等待授权 Provider。
        if (candidate?.provider === 'xiaohongshu'
          && !publicMetadata.mediaUrl
          && !publicMetadata.images?.length) {
          throw new Error('小红书图文详情不可用：Provider 和公开页面均未返回可用媒体，不能据此判断笔记不存在或账号无权限');
        }
        let downloaded;
        try {
          downloaded = await runYtDlp(sourceKey, {
            command: this.command,
            timeoutMs: remainingTimeout(),
            outputDirectory: this.cacheDirectory,
            cookiesFile: this.cookiesFile,
            cookie: this.cookie,
          });
        } catch (ytError) {
          if (isBilibili) throw ytError;
          try {
            if (ytError?.code === 'MEDIA_EXTRACTION_TIMEOUT') throw ytError;
            downloaded = await extractHtmlVideo(sourceKey, remainingTimeout(), this.cacheDirectory);
          } catch (htmlError) {
            throw new Error(`${ytError.message}；网页兜底：${htmlError.message}`);
          }
        }
        if (isBilibili && publicMetadata.page) {
          downloaded = { ...downloaded, ...publicMetadata };
        }
        // Generic direct-file extractors use the MP4 basename as a title.
        // XHS notes can intentionally have no title: retain their source title.
        if (candidate?.provider === 'xiaohongshu') downloaded.title = publicMetadata.title || '';
        else downloaded.title ||= publicMetadata.title || '';
        downloaded.coverUrl ||= publicMetadata.coverUrl || '';
        downloaded.author ||= publicMetadata.author || '';
        downloaded.avatarUrl ||= publicMetadata.avatarUrl || '';
        downloaded.description ||= publicMetadata.description || '';
        downloaded.tags ||= publicMetadata.tags || [];
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
