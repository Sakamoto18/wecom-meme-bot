const FORCE_ADD_PATTERN = /(?:强制添加|强制加入|强制存入|强制加)(?:(?:这张|这个)?(?:龙图|图片|图)(?:(?:进|到)?图库)?|(?:进|到)图库)|(?:把|将)?(?:(?:这张|这个)(?:龙图|图片|图)?|龙图)(?:强制添加|强制加入|强制加)(?:(?:进|到)?图库)?/;
const BARE_FORCE_ADD_PATTERN = /^强制(?:添加|加入|存入|收录|加)(?:图库)?$/;
const ADD_PATTERN = /(?:把|将)?(?:(?:这张|这个)(?:龙图|图片|图)?|龙图)(?:添加|加入|存入|保存|收录|加)(?:(?:进|到)?图库)?|(?:添加|加入|存入|保存|收录|加)(?:(?:这张|这个)?(?:龙图|图片|图)(?:(?:进|到)?图库)?|(?:进|到)图库)/;
const DELETE_PREVIOUS_PATTERN = /(?:删除|删掉|移除)(?:刚才|刚刚|上一张|上张)(?:发的)?龙图/;
const DELETE_THIS_PATTERN = /(?:删除|删掉|移除)(?:这张|这个)龙图|(?:这张|这个)龙图(?:删除|删掉|移除)/;
const UNDO_DELETE_PATTERN = /(?:撤销|取消)(?:刚才|刚刚|上次)?删除|恢复(?:刚才|刚刚|上次)?删除(?:的龙图)?/;
const STATUS_PATTERN = /(?:龙图|图库)(?:状态|统计|数量)|(?:状态|统计)(?:龙图|图库)/;
const SHORT_ID_PATTERN = /\bLT-[A-F0-9]{8}\b/i;
const ALIAS_STATUS_PATTERN = /^(?:(?:龙图|图库)(?:文字)?别名|(?:文字)?别名)(?:状态|统计|数量|列表|绑定)?$/;
const BIND_ALIAS_PATTERNS = [
  /^(?:强制)?(?:添加|加入|存入|收录)(?:(?:这张|这个)?(?:龙图|图片|图))?(?:(?:进|到)?图库)?[，,、 ]*(?:并且|同时|然后)?[，,、 ]*(?:标记|打标|加标签|绑定)(?:为|成)?[：:]?[“"'「『]?(.{1,48}?)[”"'」』]?(?:吧)?$/,
  /(?:把|将)?(?:这张|这个)?(?:龙图|图片|图)(?:标记|打标|加标签)(?:为|成)?[：:]?[“"'「『]?(.{1,48}?)[”"'」』]?(?:吧)?$/,
  /^(?:图片|龙图)?(?:标记|打标|加标签)(?:为|成)?[：:]?[“"'「『]?(.{1,48}?)[”"'」』]?(?:吧)?$/,
  /(?:以后|之后)?(?:再)?(?:发|说|输入|提到|喊)[“"'「『]?(.{1,48}?)[”"'」』]?(?:的时候|时)?(?:就)?(?:调用|使用|用|发|回复)(?:这张|这个)(?:龙图|图片|图)/,
  /(?:把|将)?(?:这张|这个)(?:龙图|图片|图)(?:绑定|关联|设为|设置为|指定为|固定为)(?:别名|关键词|口令)?[：:]?[“"'「『]?(.{1,48}?)[”"'」』]?(?:吧)?$/,
  /(?:绑定|关联|设定|设置)(?:别名|关键词|口令)?[“"'「『]?(.{1,48}?)[”"'」』]?(?:到|为)(?:这张|这个)(?:龙图|图片|图)/,
];
const UNBIND_ALIAS_PATTERNS = [
  /(?:取消|删除|移除|解除)[“"'「『]?(.{1,48}?)[”"'」』]?(?:的)?(?:图片|龙图)?(?:别名)?绑定/,
  /(?:取消|删除|移除|解除)(?:别名|关键词|口令)[“"'「『]?(.{1,48}?)[”"'」』]?$/,
];
const RESERVED_ALIASES = new Set([
  '图', '图片', '龙图', '表情', '表情包', '随机', '随机图', '来一张', '发一张',
]);
const SCENE_ALIAS_STOPWORDS = new Set([
  '哈哈', '哈哈哈', '好的', '好吧', '不是', '就是', '可以', '谢谢', '你好',
  '什么', '怎么', '真的', '现在', '然后', '这个', '那个',
]);

export function normalizeLongtuAlias(value) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/^[\s“”"'「」『』【】《》]+|[\s“”"'「」『』【】《》，。！？!?；;：:]+$/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (normalized.length < 2 || normalized.length > 32) return '';
  if (RESERVED_ALIASES.has(normalized) || /^LT-[A-F0-9]{8}$/i.test(normalized)) return '';
  return normalized;
}

function extractAlias(text, patterns) {
  for (const pattern of patterns) {
    const alias = normalizeLongtuAlias(text.match(pattern)?.[1]);
    if (alias) return alias;
  }
  return '';
}

export function parseLongtuManagementCommand(content) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const shortId = text.match(SHORT_ID_PATTERN)?.[0]?.toUpperCase() ?? '';
  const unbindAlias = extractAlias(text, UNBIND_ALIAS_PATTERNS);
  if (unbindAlias) {
    return { action: 'unbind-alias', force: false, shortId: '', alias: unbindAlias };
  }
  const bindAlias = extractAlias(text, BIND_ALIAS_PATTERNS);
  if (bindAlias) {
    return {
      action: 'bind-alias',
      force: /强制/.test(text),
      shortId: '',
      alias: bindAlias,
    };
  }
  if (ALIAS_STATUS_PATTERN.test(text.replace(/\s+/g, ''))) {
    return { action: 'alias-status', force: false, shortId: '', alias: '' };
  }
  if (BARE_FORCE_ADD_PATTERN.test(text) || FORCE_ADD_PATTERN.test(text)) {
    return { action: 'add', force: true, shortId };
  }
  if (ADD_PATTERN.test(text)) return { action: 'add', force: false, shortId };
  if (DELETE_PREVIOUS_PATTERN.test(text)) return { action: 'delete-previous', shortId };
  if (DELETE_THIS_PATTERN.test(text) || (shortId && /(?:删除|删掉|移除)/.test(text))) {
    return { action: 'delete-this', shortId };
  }
  if (UNDO_DELETE_PATTERN.test(text)) return { action: 'undo-delete', shortId };
  if (STATUS_PATTERN.test(text)) return { action: 'status', shortId };
  return null;
}

function compactAliasRequest(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[，。！？!?；;：:]+$/g, '')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchLongtuAliasRequest(content, bindings = []) {
  const text = compactAliasRequest(content);
  if (!text) return null;
  const sorted = [...bindings]
    .filter((binding) => binding?.alias && binding?.sha256)
    .sort((left, right) => right.alias.length - left.alias.length);
  for (const binding of sorted) {
    const alias = compactAliasRequest(binding.alias);
    if (!alias) continue;
    const escaped = escapeRegExp(alias);
    const requestPattern = new RegExp(
      `^(?:(?:给我)?(?:来|发|整|甩)(?:一)?(?:张|个)?${escaped}|${escaped})(?:龙图|图片|图|表情包)?(?:吧|呗|看看)?$`,
      'i',
    );
    if (requestPattern.test(text)) return binding;
  }
  return null;
}

export function matchLongtuContextAlias(content, bindings = []) {
  const text = compactAliasRequest(content);
  if (!text) return null;
  const sorted = [...bindings]
    .filter((binding) => (
      binding?.source === 'manual'
      && binding?.alias
      && binding?.sha256
    ))
    .sort((left, right) => right.alias.length - left.alias.length);
  return sorted.find((binding) => {
    const alias = compactAliasRequest(binding.alias);
    return alias.length >= 2 && text.includes(alias);
  }) ?? null;
}

/**
 * 根据用户原话和模型刚生成的文案，寻找最可能对应的图库文字标签。
 * 这是本地字符串匹配，不调用模型，也不会改变“发张龙图”的随机路径。
 */
export function matchLongtuSceneAlias(content, answer, bindings = []) {
  const contentText = compactAliasRequest(content);
  const answerText = compactAliasRequest(answer);
  if (!contentText && !answerText) return null;

  const scored = [];
  for (const binding of bindings) {
    const alias = compactAliasRequest(binding?.alias);
    if (
      alias.length < 2
      || RESERVED_ALIASES.has(alias)
      || SCENE_ALIAS_STOPWORDS.has(alias)
      || !binding?.sha256
    ) continue;

    const inContent = contentText.includes(alias);
    const inAnswer = answerText.includes(alias);
    if (!inContent && !inAnswer) continue;

    let score = 0;
    if (inContent) score += 2;
    if (inAnswer) score += 4;
    if (binding.source === 'manual') score += inContent ? 20 : 8;
    if (alias.length >= 4) score += 1;
    scored.push({ binding, alias, score, inContent, inAnswer });
  }

  scored.sort((left, right) => (
    right.score - left.score
    || Number(right.binding.source === 'manual') - Number(left.binding.source === 'manual')
    || right.alias.length - left.alias.length
  ));
  const best = scored[0];
  if (!best) return null;

  // OCR 标签只在原话或模型文案中有足够明确的命中时联动，避免“的/是”等短词污染正常对话。
  if (best.binding.source !== 'manual' && best.alias.length < 3) return null;
  return best.binding;
}

export function parseAdminUsers(value) {
  return new Set(String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean));
}

export function isLongtuAdministrator(userId, adminUsers) {
  return adminUsers instanceof Set && adminUsers.has(String(userId ?? '').trim());
}

export function parseProtectedRoles(value) {
  const roles = new Map();
  for (const entry of String(value ?? '').split(',')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const userId = entry.slice(0, separator).trim();
    const role = entry.slice(separator + 1).replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    if (userId && role) roles.set(userId, role);
  }
  return roles;
}
