import { normalizeMediaUrl } from './media-link-extractor.js';
import { looksRemoved, removedError } from './media-removed.js';

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
      const message = String(payload?.msg || '抖音 Provider 解析失败');
      // Provider 已判定源站把作品删了，或消息里带着源站的原话。
      if (payload?.removed === true || message.includes('content_removed') || looksRemoved(message)) {
        throw new Error(removedError('抖音', message.replace(/^.*content_removed:\s*/u, '')));
      }
      throw new Error(message);
    }
    const data = payload.data || payload;
    const kind = String(data.media_type || '');
    const gallery = kind === 'images';
    const sourceId = String(data.source_id || '');
    const requestedId = String(url || '').match(/\/(?:note|video)\/(\d+)(?:[/?#]|$)/u)?.[1];
    if (data.type_verified !== true || !/^\d+$/u.test(sourceId)
      || (requestedId && requestedId !== sourceId)
      || !['images', 'video', 'videos'].includes(kind)) {
      throw new Error('抖音作品类型未确认，请稍后重试');
    }
    const rawImages = data.images || data.image_list;
    const images = [...new Set((Array.isArray(rawImages) ? rawImages : [])
      .map((item) => normalizeMediaUrl(typeof item === 'string' ? item : item?.url || item?.url_default))
      .filter(Boolean))].slice(0, 18);
    const rawVideoItems = gallery ? [] : data.videos || data.video_items || data.videoItems
      || data.video_urls || data.videoUrls || data.mediaUrls;
    const mediaItems = [...new Map((Array.isArray(rawVideoItems) ? rawVideoItems : [])
      .map((item) => {
        const mediaUrl = normalizeMediaUrl(typeof item === 'string'
          ? item : item?.mediaUrl || item?.video_url || item?.videoUrl || item?.url);
        if (!mediaUrl) return null;
        const coverUrl = normalizeMediaUrl(typeof item === 'object'
          ? item?.coverUrl || item?.cover_url || item?.cover || item?.poster : '')
          || normalizeMediaUrl(data.coverUrl || data.cover_url || data.cover) || '';
        return [mediaUrl, {
          mediaUrl,
          coverUrl,
          size: Number(typeof item === 'object' ? item?.size || item?.video_size || item?.videoSize : 0) || 0,
          duration: Number(typeof item === 'object' ? item?.duration : 0) || 0,
          title: String(typeof item === 'object' ? item?.title || '' : ''),
          description: String(typeof item === 'object' ? item?.description || item?.desc || '' : ''),
          tags: Array.isArray(typeof item === 'object' ? item?.tags : null) ? item.tags : [],
        }];
      }).filter(Boolean)).values()];
    const rawAnimatedItems = data.animated_videos || data.animatedVideos || data.gallery_videos;
    const animatedItems = [...new Map((Array.isArray(rawAnimatedItems) ? rawAnimatedItems : [])
      .map((item) => {
        const mediaUrl = normalizeMediaUrl(typeof item === 'string'
          ? item : item?.mediaUrl || item?.video_url || item?.videoUrl || item?.url);
        if (!mediaUrl) return null;
        return [mediaUrl, {
          mediaUrl,
          coverUrl: normalizeMediaUrl(typeof item === 'object'
            ? item?.coverUrl || item?.cover_url || item?.cover : '') || '',
          size: Number(typeof item === 'object' ? item?.size || item?.video_size || item?.videoSize : 0) || 0,
          imageIndex: Number.isInteger(item?.image_index) ? item.image_index : undefined,
          requestHeaders: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
            Referer: 'https://www.douyin.com/',
          },
        }];
      }).filter(Boolean)).values()];
    // Playwright returns video_url/cover; MediaResolver requires mediaUrl/coverUrl.
    const mediaUrl = (gallery || mediaItems.length > 1)
      ? '' : normalizeMediaUrl(data.mediaUrl || data.video_url || data.videoUrl);
    if (gallery ? !images.length : (!mediaUrl && !mediaItems.length)) {
      throw new Error('抖音 Provider 未返回当前作品的可用资源');
    }
    if (mediaUrl && new URL(mediaUrl).pathname.endsWith('/uuu_265.mp4')) {
      throw new Error('抖音 Provider 返回了页面占位视频');
    }
    const description = String(data.description || data.desc || '')
      .replace(/\s+-\s+抖音\s*$/u, '')
      .replace(/来抖音，记录美好生活！?\s*$/u, '')
      .trim();
    return {
      mediaUrl,
      mediaItems: mediaItems.length > 1 ? mediaItems : [],
      animatedItems: gallery ? animatedItems : [],
      size: Number(data.size || data.video_size || data.videoSize || 0) || 0,
      images: mediaItems.length > 1
        ? [...new Set(mediaItems.map((item) => item.coverUrl).filter(Boolean))].slice(0, 18)
        : (mediaUrl ? [] : images),
      contentKind: gallery ? 'gallery' : 'video',
      sourceId,
      coverUrl: normalizeMediaUrl(data.coverUrl || data.cover_url || data.cover) || (gallery ? images[0] : '') || '',
      title: String(data.title || ''),
      description,
      author: String(data.author || ''),
      avatarUrl: normalizeMediaUrl(data.avatarUrl || data.avatar_url),
      tags: Array.isArray(data.tags) ? data.tags : [],
      duration: Number(data.duration) || 0,
    };
  };
}
