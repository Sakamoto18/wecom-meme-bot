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

async function followBilibiliRedirect(value, fetchImpl, timeoutMs) {
  const url = new URL(value);
  if (url.hostname !== 'b23.tv' && !url.hostname.endsWith('.b23.tv')) return value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(value, {
      redirect: 'follow', headers: HEADERS, signal: controller.signal,
    });
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

export async function resolveBilibiliMedia(value, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  let id = extractBilibiliVideoId(value);
  if (!id) {
    const finalUrl = await followBilibiliRedirect(value, fetchImpl, timeoutMs);
    id = extractBilibiliVideoId(finalUrl);
  }
  if (!id) return null;
  const query = new URLSearchParams(id);
  const metadata = await getJson(
    `https://api.bilibili.com/x/web-interface/view?${query}`, fetchImpl, timeoutMs,
  );
  const cid = metadata.cid || metadata.pages?.[0]?.cid;
  if (!cid) throw new Error('B站元数据中没有 cid');
  query.set('cid', String(cid));
  query.set('qn', '80');
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
    requestHeaders: HEADERS,
  };
}
