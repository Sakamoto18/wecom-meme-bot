import { createHash } from 'node:crypto';

// B 站网页接口使用 WBI 参数签名。这个表是 B 站公开客户端使用的参数置换表；
// 它只负责签名，不包含任何登录凭证。
const WBI_MIXIN_KEY_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32,
  15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
];

const DEFAULT_HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; LongtuQQBot/1.0)',
  referer: 'https://www.bilibili.com/',
};

function cleanText(value, maxLength = 1200) {
  return String(value ?? '')
    .replace(/<[^>]+>/gu, '')
    .replace(/\[\/?(?:b|i|url|color)(?:=[^\]]+)?\]/giu, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
    .slice(0, maxLength);
}

function parseJsonValue(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function collectSummaryText(value, output = [], depth = 0) {
  if (depth > 5 || value === null || value === undefined) return output;
  if (typeof value === 'string') {
    const text = cleanText(value);
    if (text.length >= 6) output.push(text);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSummaryText(item, output, depth + 1);
    return output;
  }
  if (typeof value !== 'object') return output;

  // Prefer the actual summary field over metadata or labels. The endpoint has
  // returned both a JSON string (`model_result`) and nested objects over time.
  for (const key of ['summary', 'model_summary', 'content', 'text', 'desc']) {
    if (typeof value[key] === 'string') {
      const text = cleanText(value[key]);
      if (text.length >= 6) output.push(text);
    }
  }
  for (const key of ['model_result', 'result', 'data', 'outline', 'points', 'chapters']) {
    if (value[key] !== undefined) collectSummaryText(parseJsonValue(value[key]) ?? value[key], output, depth + 1);
  }
  return output;
}

export function parseBilibiliAiSummary(payload, maxLength = 900) {
  if (!payload || typeof payload !== 'object') return '';
  const root = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const candidates = collectSummaryText(root);
  // Some deployments wrap the result in a JSON string at the top level. Keep
  // this fallback deliberately narrow so metadata labels are never rendered as
  // a fake summary.
  for (const key of ['model_result', 'summary', 'content', 'text']) {
    if (typeof root[key] !== 'string') continue;
    const parsed = parseJsonValue(root[key]);
    if (parsed) collectSummaryText(parsed, candidates);
    else {
      const text = cleanText(root[key]);
      if (text.length >= 6) candidates.push(text);
    }
  }
  const unique = [...new Set(candidates.map((text) => cleanText(text)).filter(Boolean))];
  if (unique.length === 0) return '';
  // A long outline is less useful on a compact QQ card than one concise block.
  return unique.sort((left, right) => right.length - left.length)[0].slice(0, maxLength);
}

function imageKeyFromUrl(value) {
  const text = String(value ?? '').trim();
  try {
    return new URL(text).pathname.split('/').pop()?.split('.')[0] || text;
  } catch {
    return text;
  }
}

export function buildBilibiliWbiParams(params, imgUrl, subUrl, nowSeconds = Math.floor(Date.now() / 1000)) {
  const imageKey = `${imageKeyFromUrl(imgUrl)}${imageKeyFromUrl(subUrl)}`;
  const mixinKey = WBI_MIXIN_KEY_TABLE
    .map((index) => imageKey[index] || '')
    .join('')
    .slice(0, 32);
  const signed = Object.fromEntries(
    Object.entries({ ...params, wts: nowSeconds })
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => [key, String(value)]),
  );
  const query = new URLSearchParams(Object.entries(signed).sort(([left], [right]) => left.localeCompare(right)));
  signed.w_rid = createHash('md5').update(`${query.toString()}${mixinKey}`).digest('hex');
  return signed;
}

function result(status, text = '', reason = '') {
  return {
    text: cleanText(text),
    supported: Boolean(text),
    status,
    reason,
  };
}

/**
 * Fetch the optional B 站 AI conclusion. B 站 requires an authenticated
 * account even though the ordinary view/play APIs are public. Any failure is
 * deliberately converted to an unavailable result so video delivery never
 * depends on this optional card field.
 */
export async function fetchBilibiliAiSummary({
  aid,
  bvid,
  cid,
  upMid,
  cookie = '',
  fetchImpl = fetch,
  timeoutMs = 1_500,
} = {}) {
  const normalizedCookie = String(cookie || '').trim();
  if (!normalizedCookie) return result('unsupported', '', '未配置 B 站登录态');
  if (!cid || (!aid && !bvid) || !upMid) return result('unsupported', '', '缺少 B 站总结参数');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(300, Number(timeoutMs) || 1_500));
  try {
    const headers = { ...DEFAULT_HEADERS, Cookie: normalizedCookie };
    const navResponse = await fetchImpl('https://api.bilibili.com/x/web-interface/nav', {
      headers,
      signal: controller.signal,
    });
    if (!navResponse.ok) return result('unavailable', '', `nav HTTP ${navResponse.status}`);
    const navPayload = await navResponse.json();
    const images = navPayload?.data?.wbi_img;
    if (!images?.img_url || !images?.sub_url) return result('unsupported', '', 'B 站未返回 WBI 参数');
    const params = buildBilibiliWbiParams({
      aid, bvid, cid, up_mid: upMid, web_location: '333.788',
    }, images.img_url, images.sub_url);
    const endpoint = new URL('https://api.bilibili.com/x/web-interface/view/conclusion/get');
    for (const [key, value] of Object.entries(params)) endpoint.searchParams.set(key, value);
    const response = await fetchImpl(endpoint.href, { headers, signal: controller.signal });
    if (!response.ok) return result('unavailable', '', `summary HTTP ${response.status}`);
    const payload = await response.json();
    if (Number(payload?.code) !== 0) {
      return result(
        Number(payload?.code) === -101 || Number(payload?.code) === -403 ? 'unsupported' : 'unavailable',
        '',
        String(payload?.message || payload?.code || 'B 站未提供 AI 总结'),
      );
    }
    const text = parseBilibiliAiSummary(payload);
    return text ? result('available', text) : result('unsupported', '', 'B 站未返回总结正文');
  } catch (error) {
    return result(error?.name === 'AbortError' ? 'timeout' : 'unavailable', '', error?.message || '请求失败');
  } finally {
    clearTimeout(timer);
  }
}
