import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMediaUrl } from './media-link-extractor.js';

const DEFAULT_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'parser/xhs_resolver.py',
);

export function normalizeXhsProviderData(data = {}) {
  const kind = data.media_type || data.mediaKind || data.type;
  const gallery = ['normal', 'gallery', 'image'].includes(kind);
  const mediaUrl = gallery ? '' : normalizeMediaUrl(data.video_url || data.videoUrl);
  if (kind === 'video' && !mediaUrl) throw new Error('视频笔记没有可用视频流，不能将封面作为图文发送');
  const rawImages = data.images || data.image_list;
  const images = mediaUrl ? [] : [...new Set((Array.isArray(rawImages) ? rawImages : [])
    .map((item) => normalizeMediaUrl(typeof item === 'string' ? item : item?.url_default || item?.url || item?.original_url))
    .filter(Boolean))].slice(0, 18);
  if (!mediaUrl && !images.length) throw new Error('Spider_XHS Provider 未返回媒体');
  const user = data.user || data.author || {};
  return { mediaUrl, images, coverUrl: normalizeMediaUrl(data.cover || data.cover_url || data.coverUrl || images[0] || ''), title: String(data.title || ''),
    author: String(data.author_name || data.authorName || data.nickname || user.nickname || user.name || ''),
    avatarUrl: normalizeMediaUrl(data.author_avatar || data.avatar || user.avatar || user.avatar_url || ''),
    description: String(data.description || data.desc || '').replaceAll('[话题]', '').slice(0, 4000) };
}

function runResolver(url, { command, scriptPath, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [
      scriptPath, '--url', url, '--timeout', String(Math.max(0.1, timeoutMs / 1000)),
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('小红书 Provider 解析超时'));
      if (code !== 0) return reject(new Error(`小红书 Provider 异常：${stderr.trim().slice(-300)}`));
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error('小红书 Provider 返回了无效 JSON'));
      }
    });
  });
}

export function createXhsProvider(options = {}) {
  const apiUrl = String(options.apiUrl || '').trim();
  const providerUrl = String(options.providerUrl || '').trim();
  if (!apiUrl && !providerUrl) return null;
  const timeoutMs = Math.max(100, Number(options.timeoutMs ?? 6_000));
  const command = options.command || 'python3';
  const scriptPath = options.scriptPath || DEFAULT_SCRIPT;
  const headersJson = String(options.headersJson || '').trim();
  const userAgent = String(options.userAgent || '').trim();
  const cookie = String(options.cookie || '').trim();
  return async ({ url, platform }) => {
    if (platform !== 'xiaohongshu') return null;
    if (providerUrl) {
      const response = await fetch(providerUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Spider_XHS Provider HTTP ${response.status}`);
      const external = await response.json();
      if (external?.status !== 'success') throw new Error(String(external?.msg || 'Spider_XHS Provider 解析失败'));
      return normalizeXhsProviderData(external.data || external);
    }
    const result = await runResolver(url, {
      command, scriptPath, timeoutMs,
      env: {
        ...process.env,
        XHS_DETAIL_API_URL: apiUrl,
        ...(headersJson ? { XHS_HEADERS_JSON: headersJson } : {}),
        ...(userAgent ? { XHS_USER_AGENT: userAgent } : {}),
        ...(cookie ? { XHS_COOKIE: cookie } : {}),
      },
    });
    if (result?.status !== 'success') {
      throw new Error(String(result?.msg || '小红书 Provider 解析失败'));
    }
    const mediaUrl = normalizeMediaUrl(result.data?.video_url);
    const images = [...new Set((Array.isArray(result.data?.images) ? result.data.images : [])
      .map(normalizeMediaUrl).filter(Boolean))].slice(0, 18);
    if (!mediaUrl && images.length === 0) throw new Error('小红书 Provider 未返回可发送的视频或图片');
    return {
      mediaUrl,
      images,
      coverUrl: normalizeMediaUrl(result.data?.cover),
      title: String(result.data?.title || ''),
      author: String(result.data?.author_name || result.data?.authorName || result.data?.nickname || result.data?.user?.nickname || ''),
      avatarUrl: normalizeMediaUrl(result.data?.author_avatar || result.data?.avatar || result.data?.user?.avatar || ''),
      description: String(result.data?.description || '').slice(0, 4000),
      watermarked: result.data?.watermarked === true,
    };
  };
}
