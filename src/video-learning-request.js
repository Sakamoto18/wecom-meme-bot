import { extractBilibiliPage, extractBilibiliVideoId } from './bilibili-provider.js';

// A plain share card must keep using the normal media path.  Only an explicit
// learning instruction turns a Bilibili link into a video-learning task.
const LINK_LEARNING_PATTERN = /(?:学|学习|学会|记住|记一下|记下|补课|拆解|分析|研究|弄懂|看懂|讲解|总结)[^。！？!?\n]{0,20}(?:视频|链接|这条|这个|该视频|BV|b站|bilibili|里面|梗|笑点|名场面|黑话|口头禅)|(?:视频|链接|这条|这个|该视频|BV|b站|bilibili|里面|梗|笑点|名场面|黑话|口头禅)[^。！？!?\n]{0,20}(?:学|学习|学会|记住|记一下|记下|补课|拆解|分析|研究|弄懂|看懂|讲解|总结)/iu;

export function buildVideoLearningLinkRequest({ text = '', candidates = [] } = {}) {
  const candidate = (Array.isArray(candidates) ? candidates : [])
    .find((item) => item?.provider === 'bilibili' && item?.url);
  if (!candidate) return null;
  const instruction = String(text ?? '').replace(/https?:\/\/[^\s<>"'`]+/giu, ' ').trim();
  if (!LINK_LEARNING_PATTERN.test(instruction)) return null;
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
