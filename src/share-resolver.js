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
      images: coverUrl ? [coverUrl] : [],
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
