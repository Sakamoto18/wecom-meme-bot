const FORCE_ADD_PATTERN = /(?:强制添加|强制加入|强制存入)(?:这张|这个)?龙图|(?:这张|这个)龙图(?:强制添加|强制加入)/;
const ADD_PATTERN = /(?:把|将)?(?:这张|这个)?龙图(?:添加|加入|存入|保存)(?:进|到)?图库|(?:添加|加入|保存)(?:这张|这个)?龙图/;
const DELETE_PREVIOUS_PATTERN = /(?:删除|删掉|移除)(?:刚才|刚刚|上一张|上张)(?:发的)?龙图/;
const DELETE_THIS_PATTERN = /(?:删除|删掉|移除)(?:这张|这个)龙图|(?:这张|这个)龙图(?:删除|删掉|移除)/;
const UNDO_DELETE_PATTERN = /(?:撤销|取消)(?:刚才|刚刚|上次)?删除|恢复(?:刚才|刚刚|上次)?删除(?:的龙图)?/;
const STATUS_PATTERN = /(?:龙图|图库)(?:状态|统计|数量)|(?:状态|统计)(?:龙图|图库)/;
const SHORT_ID_PATTERN = /\bLT-[A-F0-9]{8}\b/i;

export function parseLongtuManagementCommand(content) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const shortId = text.match(SHORT_ID_PATTERN)?.[0]?.toUpperCase() ?? '';
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
