const FORCE_ADD_PATTERN = /(?:强制添加|强制加入|强制存入)(?:(?:这张|这个)?(?:龙图|图片|图)(?:(?:进|到)?图库)?|(?:进|到)图库)|(?:把|将)?(?:(?:这张|这个)(?:龙图|图片|图)?|龙图)(?:强制添加|强制加入)(?:(?:进|到)?图库)?/;
const ADD_PATTERN = /(?:把|将)?(?:(?:这张|这个)(?:龙图|图片|图)?|龙图)(?:添加|加入|存入|保存)(?:(?:进|到)?图库)?|(?:添加|加入|存入|保存)(?:(?:这张|这个)?(?:龙图|图片|图)(?:(?:进|到)?图库)?|(?:进|到)图库)/;
const DELETE_PREVIOUS_PATTERN = /(?:删除|删掉|移除)(?:刚才|刚刚|上一张|上张)(?:发的)?龙图/;
const DELETE_THIS_PATTERN = /(?:删除|删掉|移除)(?:这张|这个)龙图|(?:这张|这个)龙图(?:删除|删掉|移除)/;
const UNDO_DELETE_PATTERN = /(?:撤销|取消)(?:刚才|刚刚|上次)?删除|恢复(?:刚才|刚刚|上次)?删除(?:的龙图)?/;
const STATUS_PATTERN = /(?:龙图|图库)(?:状态|统计|数量)|(?:状态|统计)(?:龙图|图库)/;
const SHORT_ID_PATTERN = /\bLT-[A-F0-9]{8}\b/i;
const ALIAS_STATUS_PATTERN = /^(?:(?:龙图|图库)(?:文字)?别名|(?:文字)?别名)(?:状态|统计|数量|列表|绑定)?$/;
const BIND_ALIAS_PATTERNS = [
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
  if (FORCE_ADD_PATTERN.test(text)) return { action: 'add', force: true, shortId };
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
