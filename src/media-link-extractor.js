import net from 'node:net';

const URL_PATTERN = /https?:\/\/[^\s<>\u3000"'`]+/giu;
const MAX_CARD_BYTES = 256 * 1024;
const MAX_CARD_DEPTH = 3;
const CANDIDATE_KEYS = new Set([
  'url', 'jumpurl', 'qqdocurl', 'web_url', 'weburl', 'video_url', 'videourl',
  'playurl', 'play_url', 'content_url', 'contenturl', 'media_url', 'mediaurl',
  'download_url', 'downloadurl', 'uri', 'href', 'link',
]);

function trimUrl(value) {
  // Share text commonly appends full-width Chinese punctuation or prose
  // directly after a URL. URL query strings are ASCII/percent encoded, so
  // cutting at Unicode punctuation avoids swallowing the following text.
  return String(value ?? '')
    .split(/[\s\u3000-\u303f\uff00-\uffef]/u, 1)[0]
    .trim()
    .replace(/[),.;!?\]}>'"\u3002，。！？》】）]+$/gu, '');
}

function isPrivateHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (net.isIP(host) === 4) {
    const parts = host.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168);
  }
  return host === '::1' || host.startsWith('fc') || host.startsWith('fd')
    || host.endsWith('.internal') || host.endsWith('.local');
}

export function normalizeMediaUrl(value) {
  const candidate = trimUrl(value);
  if (!candidate || candidate.length > 4096) return '';
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || isPrivateHost(parsed.hostname)) {
    return '';
  }
  return parsed.toString();
}

function addUrl(set, value) {
  const normalized = normalizeMediaUrl(value);
  if (normalized && !/[……]|\.\.\./u.test(normalized)) set.add(normalized);
}

function walkCard(value, urls, depth = 0) {
  if (depth > MAX_CARD_DEPTH || value === null || value === undefined) return;
  if (typeof value === 'string') {
    for (const match of value.matchAll(URL_PATTERN)) addUrl(urls, match[0]);
    if (depth < MAX_CARD_DEPTH && value.length <= MAX_CARD_BYTES) {
      try { walkCard(JSON.parse(value), urls, depth + 1); } catch { /* text */ }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) walkCard(entry, urls, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = String(key).toLowerCase().replace(/[-\s]/g, '_');
    if (CANDIDATE_KEYS.has(normalizedKey) || normalizedKey.includes('url')) {
      if (typeof entry === 'string') addUrl(urls, entry);
    }
    walkCard(entry, urls, depth + 1);
  }
}

function parseXmlUrls(xml, urls) {
  for (const match of String(xml ?? '').matchAll(/(?:https?:\/\/[^\s<>'"]+)/giu)) {
    addUrl(urls, match[0]);
  }
  for (const match of String(xml ?? '').matchAll(/(?:url|href|link|jumpurl)\s*=\s*["']([^"']+)["']/giu)) {
    addUrl(urls, match[1]);
  }
}

export function extractMediaUrls({ text = '', richSegments = [], cards = [] } = {}) {
  const urls = new Set();
  walkCard(text, urls);
  for (const segment of [...(Array.isArray(richSegments) ? richSegments : []), ...cards]) {
    if (typeof segment === 'string') {
      parseXmlUrls(segment, urls);
      walkCard(segment, urls);
    } else {
      walkCard(segment, urls);
    }
  }
  return [...urls].slice(0, 8);
}

export function classifyMediaUrl(value) {
  let host = '';
  try { host = new URL(value).hostname.toLowerCase(); } catch { return 'unknown'; }
  if (host === 'xhslink.com' || host.endsWith('.xhslink.com') || host.includes('xiaohongshu.com')) return 'xiaohongshu';
  if (host.includes('douyin.com') || host.includes('iesdouyin.com')) return 'douyin';
  if (host.includes('kuaishou.com') || host.includes('gifshow.com')) return 'kuaishou';
  if (host.includes('bilibili.com') || host === 'b23.tv') return 'bilibili';
  if (host.includes('qq.com') || host.includes('weixin.qq.com')) return 'qq';
  return 'unknown';
}

export function mediaCandidates(options = {}) {
  return extractMediaUrls(options).map((url) => ({
    url,
    provider: classifyMediaUrl(url),
  }));
}
