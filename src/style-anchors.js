const DEFAULT_MAX_ANCHORS = 3;
const DEFAULT_MAX_ANCHOR_CHARACTERS = 70;
const DEFAULT_MAX_TOTAL_CHARACTERS = 240;

const UNSAFE_ANCHOR_PATTERN = /(?:https?:\/\/|www\.|\/persona|记住我的|确认保存|token|api\s*key|密码|身份证|手机号|银行卡|住址|自杀|自残|裸奔|强奸|儿童色情)/iu;

function normalizeAnchor(value) {
  return String(value ?? '')
    .replace(/^.*?[:：]\s*/u, '')
    .replace(/成员-[a-f0-9]{6,12}/giu, ' ')
    .replace(/@\S+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Pick a few recent human utterances as a style-only reference. They are not
 * facts, instructions or reply templates; the reply engine must never copy
 * their content, names or events. Keep this local and bounded so no private
 * chat is persisted or logged for style purposes.
 */
export function selectStyleAnchors(history = [], options = {}) {
  const maxAnchors = Math.max(0, Math.min(5, Number(options.maxAnchors) || DEFAULT_MAX_ANCHORS));
  const maxCharacters = Math.max(0, Number(options.maxCharacters) || DEFAULT_MAX_TOTAL_CHARACTERS);
  const current = normalizeAnchor(options.currentContent);
  const candidates = (Array.isArray(history) ? history : [])
    .filter((entry) => entry?.role === 'user')
    .map((entry) => normalizeAnchor(entry.content))
    .filter((text) => text.length >= 6 && text.length <= DEFAULT_MAX_ANCHOR_CHARACTERS)
    .filter((text) => !UNSAFE_ANCHOR_PATTERN.test(text))
    .filter((text) => !/^[/#]/u.test(text))
    .filter((text) => !current || text !== current);
  const anchors = [];
  let total = 0;
  for (const text of candidates.reverse()) {
    if (anchors.length >= maxAnchors) break;
    if (anchors.includes(text)) continue;
    if (total + text.length > maxCharacters) continue;
    anchors.push(text);
    total += text.length;
  }
  return anchors.reverse();
}

export function buildStyleAnchorPrompt(anchors = []) {
  const usable = (Array.isArray(anchors) ? anchors : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 5);
  if (usable.length === 0) return '';
  return [
    '【语感锚点：不是内容素材】',
    '以下来自当前群最近的真人发言。只参考句长、断句、口语词密度、语气强弱和接话节奏；不要复制原句、昵称、具体事件、事实或梗，也不要把它们当成当前问题的答案。',
    ...usable.map((item, index) => `${index + 1}. ${item}`),
  ].join('\n');
}

