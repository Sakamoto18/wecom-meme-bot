import { normalizeMediaUrl } from './media-link-extractor.js';

// Cover the Provider's bounded queue (22s), resolve (20s), and page cleanup (2s).
export function createDouyinProvider({ providerUrl, timeoutMs = 50_000 } = {}) {
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
    // 图文笔记没有视频流，走和小红书图集一样的 images 字段；两者互斥，
    // 图集绝不能把封面当成单图视频发出去。
    const kind = String(data.media_type || data.mediaKind || data.type || '');
    const gallery = ['images', 'image', 'gallery', 'note'].includes(kind);
    const rawImages = data.images || data.image_list;
    const images = [...new Set((Array.isArray(rawImages) ? rawImages : [])
      .map((item) => normalizeMediaUrl(typeof item === 'string' ? item : item?.url || item?.url_default))
      .filter(Boolean))].slice(0, 18);
    // Playwright returns video_url/cover; MediaResolver requires mediaUrl/coverUrl.
    const mediaUrl = gallery ? '' : normalizeMediaUrl(data.mediaUrl || data.video_url || data.videoUrl);
    if (!mediaUrl && !images.length) throw new Error('抖音 Provider 未返回可用视频地址');
    if (mediaUrl && new URL(mediaUrl).pathname.endsWith('/uuu_265.mp4')) {
      throw new Error('抖音 Provider 返回了页面占位视频');
    }
    const description = String(data.description || data.desc || '')
      .replace(/\s+-\s+抖音\s*$/u, '')
      .replace(/来抖音，记录美好生活！?\s*$/u, '')
      .trim();
    return {
      mediaUrl,
      images: mediaUrl ? [] : images,
      coverUrl: normalizeMediaUrl(data.coverUrl || data.cover_url || data.cover) || images[0] || '',
      title: String(data.title || ''),
      description,
      author: String(data.author || ''),
      avatarUrl: normalizeMediaUrl(data.avatarUrl || data.avatar_url),
      tags: Array.isArray(data.tags) ? data.tags : [],
      duration: Number(data.duration) || 0,
    };
  };
}
