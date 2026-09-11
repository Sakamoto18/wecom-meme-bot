import { classifyMediaUrl, extractMediaUrls, normalizeMediaUrl } from './media-link-extractor.js';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const USER_AGENT = 'LongtuShareResolver/1.0 (+public metadata)';

function metaContent(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'iu'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, 'iu'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].replaceAll('&amp;', '&').trim();
  }
  return '';
}

function extractJsonLdVideo(html) {
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
    try {
      const value = JSON.parse(match[1]);
      const entries = Array.isArray(value) ? value : [value];
      for (const entry of entries) {
        const contentUrl = entry?.contentUrl || entry?.video?.contentUrl;
        const normalized = normalizeMediaUrl(contentUrl);
        if (normalized) return normalized;
      }
    } catch { /* malformed JSON-LD is ignored */ }
  }
  return '';
}

// Read page data as JSON only. Never execute scripts from a shared page.
export function extractXhsPageNote(html, canonicalUrl) {
  const parsed = new URL(canonicalUrl);
  if (parsed.hostname !== 'www.xiaohongshu.com' && parsed.hostname !== 'xiaohongshu.com') return null;
  const noteId = parsed.pathname.match(/^\/(?:explore|discovery\/item|item)\/([a-zA-Z0-9]+)\/?$/u)?.[1];
  if (!noteId) return null;
  const raw = html.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/iu)?.[1];
  if (!raw) return null;
  try {
    // The page serializes missing fields as undefined; preserve quoted text.
    const json = raw.trim().replace(/;\s*$/u, '')
      .replace(/"(?:\\.|[^"\\])*"|\bundefined\b/gu, (token) => token === 'undefined' ? 'null' : token);
    const state = JSON.parse(json);
    const note = state?.note?.noteDetailMap?.[noteId]?.note;
    if (!note || (note.noteId && note.noteId !== noteId)) return null;
    const images = (Array.isArray(note.imageList) ? note.imageList : []).map((item) => {
      const infos = Array.isArray(item.infoList) ? item.infoList : [];
      return normalizeMediaUrl(infos.find((info) => info.imageScene === 'WB_DFT')?.url
        || item.urlDefault || item.url || infos[0]?.url);
    }).filter(Boolean);
    const description = String(note.desc || '').replaceAll('[话题]', '').trim();
    const author = note.user || note.author || note.userInfo || {};
    const common = {
      title: String(note.title || ''), description, coverUrl: images[0] || '',
      author: String(author.nickname || author.nickName || author.name || note.nickname || ''),
      avatarUrl: normalizeMediaUrl(author.avatar || author.avatarUrl || author.image || ''),
    };
    if (note.type === 'normal' && images.length) {
      return { ...common, images: [...new Set(images)].slice(0, 18), mediaUrl: '', mediaKind: 'gallery' };
    }
    if (note.type === 'video') {
      const streams = note.video?.media?.stream?.h264;
      const candidates = (Array.isArray(streams) ? streams : [])
        .filter((stream) => normalizeMediaUrl(stream.masterUrl || stream.master_url || stream.url))
        .sort((a, b) => Number(a.height || 0) - Number(b.height || 0));
      const stream = candidates.find((item) => Number(item.height) >= 720) || candidates.at(-1);
      return { ...common, images, mediaKind: 'video',
        mediaUrl: normalizeMediaUrl(stream?.masterUrl || stream?.master_url || stream?.url) };
    }
  } catch { /* malformed/unavailable page data is not a successful gallery */ }
  return null;
}

export async function resolveSharedUrl(input, {
  fetchImpl = fetch,
  providerResolver = null,
  timeoutMs = 15_000,
} = {}) {
  const sourceUrl = normalizeMediaUrl(input);
  if (!sourceUrl) throw new Error('分享内容中没有合法的公网 URL');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(sourceUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
    });
    if (!response.ok) throw new Error(`分享链接返回 HTTP ${response.status}`);
    const canonicalUrl = normalizeMediaUrl(response.url || sourceUrl) || sourceUrl;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      return {
        sourceUrl,
        canonicalUrl,
        platform: classifyMediaUrl(canonicalUrl),
        title: '',
        coverUrl: '',
        mediaUrl: contentType.startsWith('video/') ? canonicalUrl : '',
      };
    }
    const html = (await response.text()).slice(0, MAX_HTML_BYTES);
    const pageNote = extractXhsPageNote(html, canonicalUrl);
    const title = metaContent(html, 'og:title') || metaContent(html, 'twitter:title');
    const description = metaContent(html, 'og:description') || metaContent(html, 'description');
    const coverUrl = normalizeMediaUrl(metaContent(html, 'og:image') || metaContent(html, 'twitter:image'));
    const mediaUrl = normalizeMediaUrl(
      metaContent(html, 'og:video')
      || metaContent(html, 'og:video:url')
      || metaContent(html, 'twitter:player:stream')
      || extractJsonLdVideo(html),
    );
    const result = {
      sourceUrl,
      canonicalUrl,
      platform: classifyMediaUrl(canonicalUrl),
      title,
      description,
      coverUrl,
      mediaUrl,
      images: mediaUrl ? [] : (coverUrl ? [coverUrl] : []),
      ...pageNote,
    };
    if (typeof providerResolver === 'function') {
      const provided = await providerResolver(result);
      if (provided?.mediaUrl && normalizeMediaUrl(provided.mediaUrl)) {
        return { ...result, ...provided, mediaUrl: normalizeMediaUrl(provided.mediaUrl) };
      }
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export function extractShareUrls({ text = '', richSegments = [] } = {}) {
  return extractMediaUrls({ text, richSegments });
}
