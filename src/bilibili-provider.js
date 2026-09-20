import { normalizeMediaUrl } from './media-link-extractor.js';
import { isBilibiliRemovedCode, looksRemoved, removedError } from './media-removed.js';

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; LongtuQQBot/1.0)',
  referer: 'https://www.bilibili.com/',
};

export function bilibiliPartError(message) {
  const error = new Error(message);
  error.code = 'BILIBILI_PART_UNAVAILABLE';
  return error;
}

export function isBilibiliPartError(error) {
  return error?.code === 'BILIBILI_PART_UNAVAILABLE';
}

// QQ player links use `page`; normal video pages use `p`. Card URLs can
// contain an encoded destination or XML-escaped query separators.
export function extractBilibiliPage(value, depth = 0) {
  let url;
  try { url = new URL(String(value || '').replaceAll('&amp;', '&')); } catch { return null; }
  const raw = url.searchParams.get('p') ?? url.searchParams.get('page');
  if (raw !== null) {
    const page = Number(raw);
    if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(page) || page < 1) {
      throw bilibiliPartError('B站分享的分 P 参数无效，请检查链接后重试。');
    }
    return page;
  }
  if (depth < 3) {
    for (const nested of url.searchParams.values()) {
      if (/^https?:\/\//iu.test(nested)) {
        const page = extractBilibiliPage(nested, depth + 1);
        if (page !== null) return page;
      }
    }
  }
  return null;
}

function videoPageUrl(id, page) {
  const video = id.bvid || `av${id.aid}`;
  return `https://www.bilibili.com/video/${video}${page > 1 ? `?p=${page}` : ''}`;
}

export function normalizeBilibiliSource(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (!(host === 'bilibili.com' || host.endsWith('.bilibili.com'))) return value;
  if (host !== 'player.bilibili.com' && !/^\/video\/(?:BV[0-9A-Za-z]+|av\d+)\/?$/iu.test(url.pathname)) return value;
  const id = extractBilibiliVideoId(value);
  return id ? videoPageUrl(id, extractBilibiliPage(value) ?? 1) : value;
}

export function extractBilibiliVideoId(value) {
  const raw = String(value || '');
  const decoded = (() => {
    try { return decodeURIComponent(raw); } catch { return raw; }
  })();
  const anywhereBvid = decoded.match(/(?:^|[^0-9A-Za-z])(BV[0-9A-Za-z]{10,})/iu)?.[1];
  if (anywhereBvid) return { bvid: anywhereBvid };
  const anywhereAid = decoded.match(/(?:^|[^0-9A-Za-z])av(\d+)/iu)?.[1];
  if (anywhereAid) return { aid: anywhereAid };
  const url = new URL(raw);
  const queryBvid = String(url.searchParams.get('bvid') || '').trim();
  if (/^BV[0-9A-Za-z]+$/u.test(queryBvid)) return { bvid: queryBvid };
  const pathBvid = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/iu)?.[1];
  if (pathBvid) return { bvid: pathBvid };
  const queryAid = String(url.searchParams.get('aid') || '').trim();
  if (/^\d+$/u.test(queryAid)) return { aid: queryAid };
  const pathAid = url.pathname.match(/\/video\/av(\d+)/iu)?.[1];
  return pathAid ? { aid: pathAid } : null;
}

export function extractBilibiliVideoIdFromToolOutput(value) {
  const raw = String(value || '');
  // Prefer the resolved video URL over the bare BV ID, otherwise a failed
  // webpage fetch can silently turn a short link to P2 into P1.
  for (const match of raw.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    try {
      const url = new URL(match[0]);
      if (!(url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com'))) continue;
      const id = extractBilibiliVideoId(url.href);
      const page = extractBilibiliPage(url.href);
      if (id && page !== null) return { ...id, page };
    } catch (error) {
      if (isBilibiliPartError(error)) throw error;
    }
  }
  const direct = raw.match(/\b(BV[0-9A-Za-z]{10,})\b/u)?.[1];
  if (direct) return { bvid: direct };
  const extractorId = raw.match(/\[BiliBili\]\s+(?:Extracting URL:\s*)?(?:BV)?([0-9A-Za-z]{10,})/iu)?.[1];
  return extractorId ? { bvid: `BV${extractorId}` } : null;
}

async function followBilibiliRedirect(value, fetchImpl, timeoutMs) {
  const url = new URL(value);
  if (url.hostname !== 'b23.tv' && !url.hostname.endsWith('.b23.tv')) return value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(value, {
      redirect: 'manual', headers: HEADERS, signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) return new URL(location, value).href;
    }
    if (!response.ok) throw new Error(`B站短链返回 HTTP ${response.status}`);
    return response.url || value;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: HEADERS, signal: controller.signal });
    if (!response.ok) throw new Error(`B站接口返回 HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.code !== 0 || !payload.data) {
      // 稿件被删/不可见时 B站给的是明确业务码，别和网络错误混在一起。
      if (isBilibiliRemovedCode(payload?.code) || looksRemoved(payload?.message)) {
        throw new Error(removedError('B站', `code=${payload?.code} ${payload?.message || ''}`.trim()));
      }
      throw new Error(`B站接口错误 ${payload?.code ?? 'unknown'}`);
    }
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveBilibiliMedia(value, {
  fetchImpl = fetch, timeoutMs = 15_000, shortLinkIdResolver,
} = {}) {
  let id = extractBilibiliVideoId(value);
  let requestedPage = extractBilibiliPage(value);
  let uncertainPart = false;
  if (!id) {
    try {
      const finalUrl = await followBilibiliRedirect(value, fetchImpl, timeoutMs);
      id = extractBilibiliVideoId(finalUrl);
      requestedPage ??= extractBilibiliPage(finalUrl);
    } catch (error) {
      if (isBilibiliPartError(error)) throw error;
      if (!shortLinkIdResolver) throw error;
      id = await shortLinkIdResolver(value);
      if (!id) throw error;
      requestedPage ??= id.page ?? null;
      uncertainPart = requestedPage === null;
    }
  }
  if (!id) return null;
  const page = requestedPage ?? 1;
  const query = new URLSearchParams(id.bvid ? { bvid: id.bvid } : { aid: id.aid });
  const sourceUrl = uncertainPart ? value : videoPageUrl(id, page);
  let cardMetadata;
  try {
    const metadata = await getJson(
      `https://api.bilibili.com/x/web-interface/view?${query}`, fetchImpl, timeoutMs,
    );
    const pages = Array.isArray(metadata.pages) ? metadata.pages : [];
    if (uncertainPart && (pages.length > 1 || Number(metadata.videos) > 1)) {
      throw bilibiliPartError('B站短链暂时无法确认分 P，请复制带 p=数字 的视频页面链接后重试。');
    }
    const selected = pages.find((item) => Number(item.page) === page);
    if ((pages.length && !selected) || (page > 1 && !selected?.cid)) {
      throw bilibiliPartError(`B站分享指定的 P${page} 不存在或暂时无法读取，请检查分 P 后重试。`);
    }
    const cid = selected?.cid || (page === 1 ? metadata.cid : null);
    if (!cid) throw new Error('B站元数据中没有 cid');
    const title = String(metadata.title || '');
    const partTitle = String(selected?.part || '').trim();
    cardMetadata = {
      title: (pages.length > 1 || page > 1
        ? `${title} · P${page}${partTitle && partTitle !== title ? ` ${partTitle}` : ''}`
        : title).slice(0, 200),
      description: String(metadata.desc || '').slice(0, 4000),
      coverUrl: normalizeMediaUrl(selected?.first_frame || metadata.pic || metadata.cover || ''),
      author: String(metadata.owner?.name || ''),
      avatarUrl: normalizeMediaUrl(metadata.owner?.face || ''),
      publishedAt: Number(metadata.pubdate || 0),
      duration: Number(selected?.duration ?? (page === 1 && !pages.length ? metadata.duration : 0)) || 0,
      page, cid: String(cid), sourceUrl,
    };
    query.set('cid', String(cid));
    // Mobile playback baseline: prefer 720P instead of always requesting the largest stream.
    query.set('qn', '64');
    query.set('fnval', '1');
    query.set('fourk', '1');
    const play = await getJson(
      `https://api.bilibili.com/x/player/playurl?${query}`, fetchImpl, timeoutMs,
    );
    const stream = [...(play.durl || [])]
      .filter((item) => normalizeMediaUrl(item?.url))
      .sort((left, right) => Number(right.size || 0) - Number(left.size || 0))[0];
    if (!stream) throw new Error('B站公开播放接口没有返回 MP4 流');
    // The API may put a slow edge/P2P node first while supplying fast UPOS
    // alternatives. Use only those original signed URLs; keep the primary as fallback.
    const mediaUrls = [...new Set([stream.url, ...(Array.isArray(stream.backup_url) ? stream.backup_url : [])]
      .map(normalizeMediaUrl).filter(Boolean))];
    const priority = (url) => {
      const host = new URL(url).hostname;
      return host.startsWith('upos-') && host.endsWith('.bilivideo.com') ? 0 : 1;
    };
    mediaUrls.sort((left, right) => priority(left) - priority(right));
    return {
      ...cardMetadata,
      mediaUrl: mediaUrls[0],
      backupMediaUrls: mediaUrls.slice(1),
      size: Number(stream.size || 0),
      quality: Number(play.quality || 0),
      requestHeaders: HEADERS,
    };
  } catch (error) {
    error.sourceUrl = sourceUrl;
    if (cardMetadata) error.mediaMetadata = cardMetadata;
    throw error;
  }
}
