import { normalizeMediaUrl } from './media-link-extractor.js';

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; LongtuQQBot/1.0)',
  referer: 'https://www.bilibili.com/',
};

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
  if (!id) {
    try {
      const finalUrl = await followBilibiliRedirect(value, fetchImpl, timeoutMs);
      id = extractBilibiliVideoId(finalUrl);
    } catch (error) {
      if (!shortLinkIdResolver) throw error;
      id = await shortLinkIdResolver(value);
      if (!id) throw error;
    }
  }
  if (!id) return null;
  const query = new URLSearchParams(id);
  const metadata = await getJson(
    `https://api.bilibili.com/x/web-interface/view?${query}`, fetchImpl, timeoutMs,
  );
  const cid = metadata.cid || metadata.pages?.[0]?.cid;
  if (!cid) throw new Error('B站元数据中没有 cid');
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
  return {
    mediaUrl: normalizeMediaUrl(stream.url),
    size: Number(stream.size || 0),
    title: String(metadata.title || '').slice(0, 200),
    duration: Number(metadata.duration || 0),
    quality: Number(play.quality || 0),
    requestHeaders: HEADERS,
  };
}
