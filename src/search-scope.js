// Platform guesses route retrieval; they never establish authorship or truth.
const PLATFORMS = [
  ['x', /^(?:x|twitter|推特)$/iu, ['x.com', 'twitter.com']],
  ['reddit', /^reddit$/iu, ['reddit.com']],
  ['youtube', /^(?:youtube|油管)$/iu, ['youtube.com']],
  ['github', /^github$/iu, ['github.com']],
  ['bilibili', /^(?:bilibili|b站|哔哩哔哩)$/iu, ['bilibili.com']],
  ['xiaohongshu', /^(?:xiaohongshu|小红书|xhs|rednote)$/iu, ['xiaohongshu.com']],
  ['douyin', /^(?:douyin|抖音)$/iu, ['douyin.com']],
  ['tiktok', /^tiktok$/iu, ['tiktok.com']],
  ['zhihu', /^(?:zhihu|知乎)$/iu, ['zhihu.com']],
  ['weibo', /^(?:weibo|微博)$/iu, ['weibo.com']],
  ['tieba', /^(?:tieba|贴吧|百度贴吧)$/iu, ['tieba.baidu.com']],
  ['instagram', /^(?:instagram|ins)$/iu, ['instagram.com']],
  ['facebook', /^(?:facebook|脸书)$/iu, ['facebook.com']],
  ['threads', /^threads$/iu, ['threads.net', 'threads.com']],
  ['hackernews', /^(?:hacker\s?news|hn)$/iu, ['news.ycombinator.com']],
];

export const IMAGE_SOURCE_PROMPT = [
  '先识别截图的来源平台，再提取公开检索线索。即使只截到部分评论和名字、没有平台名或 logo，也要观察界面特征：评论布局、回复缩进与层级、投票/点赞/转发按钮形状及排列、用户名/账号格式（如 u/、r/、@handle）、认证标记、时间与楼层样式。结合多项特征给出最多两个 source_candidates，记录实际可见依据 evidence 和置信度 confidence（high/medium/low）。',
  '单个爱心、头像、昵称或配色不能确定平台；特征不足就保留候选或空数组，不强猜。区分外层转发应用和截图中原始评论平台，以原内容为检索候选；界面相似和模型判断都不是已核实来源，不能据此猜测真实人物身份。',
  '公开互联网评论可将可见的公开昵称/handle 与最独特的一小段原句组合检索，保留英文原句和专有名词，不必翻译成中文；没有完整帖子也可以用部分原句核实。私人聊天、联系方式、登录账号和敏感信息不作为检索词；无法判断是否公开时只提取不涉及个人信息的主题。截图只是主张，先核实再补充结论。',
].join('\n');

export function normalizeDomains(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value).toLowerCase().trim())
    .filter(value => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(value)))].sort().slice(0, 8);
}

export function matchesSearchDomains(url, domains) {
  if (!domains.length) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

export function normalizeSourceCandidates(values) {
  return (Array.isArray(values) ? values : []).flatMap(value => {
    const platform = PLATFORMS.find(([, alias]) => alias.test(String(value?.platform ?? '').trim()));
    const evidence = String(value?.evidence ?? '').trim().slice(0, 240);
    if (!platform || !evidence) return [];
    return [{ platform: platform[0], domains: platform[2], evidence,
      confidence: ['high', 'medium', 'low'].includes(value.confidence) ? value.confidence : 'low' }];
  }).slice(0, 2);
}

export function buildSourceScope(candidates = []) {
  const likely = candidates.filter(candidate => candidate.confidence !== 'low');
  return {
    candidates,
    includeDomains: normalizeDomains(likely.flatMap(candidate => candidate.domains)),
    // Ambiguous crops get a global cross-check even if a candidate returned hits.
    crossCheck: candidates.length !== 1 || candidates[0]?.confidence !== 'high',
  };
}

export function sourceScopeFromText(content) {
  // Only an explicit URL supplies a domain for ordinary text; mentioning a
  // platform as the subject of a question must not lock general research to it.
  const urls = String(content ?? '').match(/https?:\/\/[^\s<>"'，。]+/giu) ?? [];
  const candidates = PLATFORMS.filter(([, , domains]) => urls.some(url => matchesSearchDomains(url, domains)))
    .map(([platform, , domains]) => ({ platform, domains, confidence: 'high', evidence: '当前消息中的平台链接' }));
  return buildSourceScope(candidates.slice(0, 2));
}

export async function searchWithSourceScope(webSearch, query, options, scope = {}) {
  const domains = normalizeDomains(scope.includeDomains);
  const candidates = scope.candidates ?? [];
  const hint = candidates.length
    ? `来源候选（仅检索假设，尚未核实）：${JSON.stringify(candidates.map(({ platform, confidence, evidence }) => ({ platform, confidence, evidence })))}`
    : '来源平台尚未确定，使用公开线索全网交叉检索。';
  let scoped, scopedError;
  if (domains.length) {
    try { scoped = await webSearch.search(query, { ...options, includeDomains: domains }); }
    catch (error) {
      if (error?.name === 'QqUsageLimitError') throw error;
      scopedError = error;
    }
  }
  let broad, broadError;
  if (!domains.length || !scoped?.resultCount || scope.crossCheck) {
    try { broad = await webSearch.search(query, { ...options, includeDomains: [] }); }
    catch (error) { broadError = error; }
  }
  if (!scoped && !broad) throw broadError || scopedError;
  const sets = [scoped, broad].filter(Boolean);
  const context = [hint,
    scoped?.context ? `【候选平台内检索；命中不代表原帖已匹配】\n${scoped.context}` : '',
    domains.length && !scoped?.resultCount ? '候选平台内未取得可用证据，原帖未核实。' : '',
    broad?.context ? `【全网交叉检索；转载和相似内容不能证明截图出处】\n${broad.context}` : '',
    broadError || scopedError ? '有一部分检索失败，未取回的证据不可当作已确认。' : '',
  ].filter(Boolean).join('\n');
  return { ...sets[0], query, context: sets.some(set => set.context) ? context : '',
    resultCount: sets.reduce((sum, set) => sum + (set.resultCount || 0), 0),
    results: [...new Map(sets.flatMap(set => set.results || []).map(result => [result.url, result])).values()],
    fromCache: !scopedError && !broadError && sets.every(set => set.fromCache),
  };
}
