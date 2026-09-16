import { normalizeMediaUrl } from './media-link-extractor.js';

export function createDouyinProvider({ providerUrl, timeoutMs = 25_000 } = {}) {
  const endpoint = String(providerUrl || '').trim();
  if (!endpoint) return null;
  return async ({ url, platform }) => {
    if (platform !== 'douyin') return null;
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`抖音 Provider HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.status !== 'success') {
      throw new Error(String(payload?.msg || '抖音 Provider 解析失败'));
    }
    const data = payload.data || payload;
    // Playwright returns video_url/cover; MediaResolver requires mediaUrl/coverUrl.
    const mediaUrl = normalizeMediaUrl(data.mediaUrl || data.video_url || data.videoUrl);
    if (!mediaUrl) throw new Error('抖音 Provider 未返回可用视频地址');
    if (new URL(mediaUrl).pathname.endsWith('/uuu_265.mp4')) {
      throw new Error('抖音 Provider 返回了页面占位视频');
    }
    return {
      mediaUrl,
      coverUrl: normalizeMediaUrl(data.coverUrl || data.cover_url || data.cover),
      title: String(data.title || ''),
      description: String(data.description || data.desc || ''),
      author: String(data.author || ''),
      avatarUrl: normalizeMediaUrl(data.avatarUrl || data.avatar_url),
      tags: Array.isArray(data.tags) ? data.tags : [],
      duration: Number(data.duration) || 0,
    };
  };
}
