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
    // 图文笔记没有视频流，走和小红书图集一样的 images 字段；两者互斥，
    // 图集绝不能把封面当成单图视频发出去。
    const kind = String(data.media_type || data.mediaKind || data.type || '');
    const gallery = ['images', 'image', 'gallery', 'note'].includes(kind);
    // 页面上没有可播媒体、但标题/作者/封面已经拿到的情形。这里不算失败：让
    // 上游走 yt-dlp 取视频，再用这份元数据补齐卡片。
    const metadataOnly = kind === 'metadata';
    const rawImages = data.images || data.image_list;
    const images = [...new Set((Array.isArray(rawImages) ? rawImages : [])
      .map((item) => normalizeMediaUrl(typeof item === 'string' ? item : item?.url || item?.url_default))
      .filter(Boolean))].slice(0, 18);
    const rawVideoItems = data.videos || data.video_items || data.videoItems
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
          requestHeaders: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
            Referer: 'https://www.douyin.com/',
          },
        }];
      }).filter(Boolean)).values()];
    // Playwright returns video_url/cover; MediaResolver requires mediaUrl/coverUrl.
    const mediaUrl = (gallery || metadataOnly || mediaItems.length > 1)
      ? '' : normalizeMediaUrl(data.mediaUrl || data.video_url || data.videoUrl);
    // 声明了 metadata 却什么都没带，等于一无所获，不能当成功放过去。
    const usefulMetadata = metadataOnly && Boolean(
      data.title || data.author || data.description
      || data.cover || data.cover_url || data.coverUrl,
    );
    if (!mediaUrl && !mediaItems.length && !images.length && !usefulMetadata) {
      throw new Error('抖音 Provider 未返回可用视频地址');
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
      metadataOnly,
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
