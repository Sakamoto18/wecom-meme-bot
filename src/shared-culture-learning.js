import { buildSharedCultureCorrectionCard } from './culture-cache.js';

const CORRECTION_CUE = /(?:我(?:是说|的意思是|指的是|问的是)|不是(?:说|我)|不对(?:吧|啊)?|错了|你(?:理解|听|看)错了|说的是你|指的是你|我让你|重点是)/u;
const BOT_UNCERTAINTY = /(?:没(?:查|找到|搜到|看|听说)|无法(?:确认|核实)|不能确认|不知道|不清楚|尚未开始|没有记录|没这回事)/u;
const BOT_CHALLENGE = /你(?:昨天|前天|刚才|上一轮|还).{0,18}(?:不知道|没看|没查|不懂|没跟上)/u;
const PUBLIC_TERM_PATTERN = /(?:全名(?:叫|是)|叫作?|指的是|就是|对应(?:的)?是)\s*[“”"'‘’「」『』]?([\p{Script=Han}\p{L}\p{N}][\p{Script=Han}\p{L}\p{N}_-]{1,18})/gu;
const NUMBER_TERM_PATTERN = /(?<![\p{L}\p{N}])\d{3,4}(?![\p{L}\p{N}])/gu;
const NICKNAME_TERM_PATTERN = /(?<![\p{L}\p{N}])([\p{Script=Han}\p{L}\p{N}]{1,10}?(?:哥|姐|队|神|皇|老师|妹))(?![\p{L}\p{N}])/gu;
const REPEATED_TERM_PATTERN = /(?<![\p{L}\p{N}])(?<term>[\p{Script=Han}\p{L}\p{N}]{2,8})\s*\k<term>(?![\p{L}\p{N}])/gu;
const QUOTED_TERM_PATTERN = /[“"「『]([^”"」』\n]{2,20})[”"」』]/gu;
const PERSONAL_ATTACK_FILLER = /(?:他妈的?|你妈的?|傻[逼比]|弱智|脑残|废物|狗东西|死妈|妈的|操你妈)/giu;

function clean(value, limit = 500) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/成员-[a-f0-9]{6,12}/giu, '')
    .replace(/(?:当前发言人|本轮回复对象)QQ号[^：:]*[：:]\s*\d+/gu, '')
    .replace(/(?:当前发言人|本轮回复对象)[：:]\s*[^\n]+/gu, '')
    .replace(PERSONAL_ATTACK_FILLER, ' ')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
}

function historyText(history = []) {
  return (Array.isArray(history) ? history : [])
    .slice(-10)
    .map((entry) => clean(entry?.content, 600))
    .filter(Boolean);
}

function extractTerms(text) {
  const source = clean(text, 2_000);
  const terms = [];
  for (const match of source.matchAll(REPEATED_TERM_PATTERN)) {
    const candidate = clean(match.groups?.term ?? '', 40);
    // Do not turn “哈哈哈哈”/“啊啊啊” into a shared meme card. A repeated
    // term must carry at least two different characters or a known public
    // nickname/number shape.
    if (candidate.length >= 2 && new Set([...candidate]).size > 1) terms.push(candidate);
  }
  for (const pattern of [PUBLIC_TERM_PATTERN, NUMBER_TERM_PATTERN, NICKNAME_TERM_PATTERN, QUOTED_TERM_PATTERN]) {
    for (const match of source.matchAll(pattern)) {
      const candidate = clean(match[1] ?? match[0], 40);
      if (candidate.length >= 2) terms.push(candidate);
    }
  }
  return [...new Set(terms)].slice(0, 10);
}

function repeatedTerms(text) {
  const source = clean(text, 2_000);
  return [...source.matchAll(REPEATED_TERM_PATTERN)]
    .map((match) => clean(match.groups?.term ?? '', 40))
    .filter((term) => term.length >= 2 && new Set([...term]).size > 1);
}

function hasCorrectionSignal(currentText, history) {
  const current = clean(currentText, 800);
  if (!current) return false;
  const previousAssistant = history
    .filter((entry) => entry?.role === 'assistant')
    .at(-1)?.content ?? '';
  return CORRECTION_CUE.test(current)
    || (BOT_UNCERTAINTY.test(previousAssistant) && BOT_CHALLENGE.test(current));
}

/**
 * Build a privacy-safe shared card only when a user is correcting an uncertain
 * bot answer. It intentionally does not treat a normal topic mention as
 * learning: the old group answer must contain uncertainty, or the current
 * turn must carry an explicit correction cue.
 */
export function buildSharedCorrectionFromConversation({ currentText, history = [] } = {}) {
  const current = clean(currentText, 800);
  const previous = historyText(history);
  if (!current || !hasCorrectionSignal(current, history)) return null;
  const combined = [...previous, current].join('\n');
  const terms = extractTerms(combined);
  if (terms.length === 0) return null;

  // Prefer a numeric/public proper term as the canonical topic. For “9哥全名
  // 叫369” this produces topic=369, aliases=[9哥], while avoiding a generic
  // “八强” or “比赛” card.
  const topic = terms.find((term) => /^\d{3,4}$/u.test(term))
    || terms.find((term) => /(?:哥|姐|队|神|皇|老师)$/u.test(term))
    || terms[0];
  const aliases = terms.filter((term) => term !== topic).slice(0, 6);
  const relatedUserTurns = (Array.isArray(history) ? history : [])
    .filter((entry) => entry?.role === 'user')
    .map((entry) => clean(entry.content, 220))
    .filter((line) => line && terms.some((term) => line.includes(term)))
    .slice(-2);
  const context = clean([
    `纠正要点：${current}`,
    relatedUserTurns.length > 0 ? `关联公开语境：${relatedUserTurns.join('；')}` : '',
  ].filter(Boolean).join('；'), 180);
  return buildSharedCultureCorrectionCard({
    topic,
    aliases,
    context,
  });
}

/**
 * Learn a small public meme hint from repetition alone. This is intentionally
 * stricter than normal group memory: a term must either repeat in the current
 * message (for example “九妹九妹”) or appear in at least two user turns. The
 * card contains only the phrase and its public conversational wording; no
 * group/member identity is retained.
 */
export function buildSharedRecurrenceFromConversation({ currentText, history = [] } = {}) {
  const current = clean(currentText, 800);
  if (!current) return null;
  const userLines = [
    ...(Array.isArray(history) ? history : [])
      .filter((entry) => entry?.role === 'user')
      .map((entry) => clean(entry.content, 500))
      .filter(Boolean),
    current,
  ];
  const currentRepeated = repeatedTerms(current);
  const candidateTerms = [...new Set([
    ...currentRepeated,
    ...extractTerms(userLines.join('\n')).filter((term) => userLines.filter((line) => line.includes(term)).length >= 2),
  ])];
  if (candidateTerms.length === 0) return null;
  const topic = candidateTerms.find((term) => currentRepeated.includes(term))
    || candidateTerms.find((term) => /(?:哥|姐|队|神|皇|老师|妹)$/u.test(term))
    || candidateTerms.find((term) => /^\d{3,4}$/u.test(term));
  if (!topic) return null;
  const related = userLines.filter((line) => line.includes(topic)).slice(-3);
  const context = clean([
    `重复公共表达：${topic}`,
    related.length > 0 ? `当前公开语境：${related.join('；')}` : '',
  ].filter(Boolean).join('；'), 180);
  return buildSharedCultureCorrectionCard({
    topic,
    aliases: candidateTerms.filter((term) => term !== topic).slice(0, 6),
    context,
    lookupSource: 'group-recurrence',
    evidenceQuality: 'conversation-recurrence',
    confidence: 'low',
    ttlMs: 30 * 24 * 60 * 60 * 1000,
  });
}

