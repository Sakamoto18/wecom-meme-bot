import { extractBilibiliPage, extractBilibiliVideoId } from './bilibili-provider.js';

// Any B 站 link in a direct message or its quote is only a candidate; the
// turn planner decides from the wording whether the user asked to learn it.
// A fixed keyword list missed phrasings like “学习一下，全文背诵”.
export function buildVideoLearningLinkRequest({ text = '', candidates = [] } = {}) {
  const candidate = (Array.isArray(candidates) ? candidates : [])
    .find((item) => item?.provider === 'bilibili' && item?.url);
  if (!candidate) return null;
  // A bare share (link plus its 【title】) is not an instruction; it keeps
  // the normal media path. Anything else the user wrote goes to the planner.
  const instruction = String(text ?? '')
    .replace(/https?:\/\/[^\s<>"'`]+/giu, ' ')
    .replace(/【[^】]*】/gu, ' ')
    .replace(/@\S+/gu, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  if (!instruction) return null;
  let bvid = '';
  let page = 1;
  try {
    bvid = extractBilibiliVideoId(candidate.url)?.bvid || '';
    page = extractBilibiliPage(candidate.url) || 1;
  } catch {
    bvid = '';
    page = 1;
  }
  return {
    directLink: true,
    // Share text can concatenate an @mention directly after the BV path. A
    // canonical video URL prevents that mention from reaching the resolver.
    preferredUrl: bvid
      ? `https://www.bilibili.com/video/${bvid}${page > 1 ? `?p=${page}` : ''}`
      : candidate.url,
    preferredBvid: bvid,
  };
}
