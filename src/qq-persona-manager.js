import { normalizePersonaProfile } from './qq-persona-store.js';

const PERSONA_PREFIX = /^\/persona(?:\s+([\s\S]*))?$/i;
const REMEMBER_PATTERN = /^(?:记住|保存|把)(?:我的)?(?:长期)?(口癖|说话习惯|角色口癖|角色习惯|人格补充)[：:]\s*(.+)$/u;
const ROLE_REMEMBER_PATTERN = /^把(?:这句|这条|上面这句)?设为(?:我的)?(?:长期)?(?:口癖|角色习惯|人格补充)[：:]?\s*(.*)$/u;
const CONFIRM_PATTERN = /^(?:确认|确认保存|保存这个|就这样保存)$/u;
const CANCEL_PATTERN = /^(?:取消|取消保存|不要保存|删掉这个待保存)$/u;

function compact(value, max = 4_000) {
  return String(value ?? '').replace(/[\u0000\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function scopeLabel(scopeType, scopeId) {
  if (scopeType === 'global') return '全局人格';
  if (scopeType === 'group') return `当前群 ${scopeId} 的人格补充`;
  return '你的专属口癖';
}

function profileText(profile) {
  const parts = [];
  if (profile.styleRules?.length) parts.push(`表达规则：${profile.styleRules.join('；')}`);
  if (profile.preferredPhrases?.length) parts.push(`偏好口癖：${profile.preferredPhrases.join('、')}`);
  if (profile.avoidPatterns?.length) parts.push(`避免表达：${profile.avoidPatterns.join('；')}`);
  if (profile.examples?.length) {
    parts.push(`示例：${profile.examples.map((entry) => `“${entry.input}”→“${entry.output}”`).join('；')}`);
  }
  return parts.join('\n');
}

function mergeProfiles(previous, next) {
  return {
    styleRules: [...new Set([...(previous?.styleRules ?? []), ...(next?.styleRules ?? [])])],
    preferredPhrases: [...new Set([...(previous?.preferredPhrases ?? []), ...(next?.preferredPhrases ?? [])])],
    avoidPatterns: [...new Set([...(previous?.avoidPatterns ?? []), ...(next?.avoidPatterns ?? [])])],
    examples: [...(previous?.examples ?? []), ...(next?.examples ?? [])],
  };
}

function parseProfileText(value, kind = 'rule') {
  const text = compact(value);
  if (!text) return null;
  if (kind === 'phrase') return normalizePersonaProfile({ preferredPhrases: [text] });
  const example = text.match(/^输入[“"']?(.{1,180})[”"']?\s*(?:=>|→|回答为|答)[：:]?\s*[“"']?(.{1,300})[”"']?$/u);
  if (kind === 'example' && example) {
    return normalizePersonaProfile({ examples: [{ input: example[1], output: example[2] }] });
  }
  return normalizePersonaProfile({ styleRules: [text] });
}

export function parsePersonaRequest(value) {
  const text = compact(value);
  if (!text) return null;
  const slash = text.match(PERSONA_PREFIX);
  if (slash) {
    const argument = compact(slash[1] ?? '');
    if (!argument) return { action: 'help' };
    const [command, ...rest] = argument.split(/\s+/u);
    const normalizedCommand = command.toLowerCase();
    const remainder = rest.join(' ').trim();
    if (['train', 'start', 'help'].includes(normalizedCommand)) {
      return { action: normalizedCommand === 'help' ? 'help' : 'train', argument: remainder, slash: true };
    }
    if (['save', 'confirm'].includes(normalizedCommand)) return { action: 'confirm', slash: true };
    if (['cancel', 'reject'].includes(normalizedCommand)) return { action: 'cancel', slash: true };
    if (['preview', 'pending'].includes(normalizedCommand)) return { action: 'preview', slash: true };
    if (['list', 'status'].includes(normalizedCommand)) return { action: 'list', slash: true };
    if (['undo', 'revert'].includes(normalizedCommand)) return { action: 'undo', argument: remainder, slash: true };
    if (['off', 'disable'].includes(normalizedCommand)) return { action: 'disable', argument: remainder, slash: true };
    if (['add', 'rule', 'phrase', 'example'].includes(normalizedCommand)) {
      return {
        action: 'draft',
        kind: normalizedCommand === 'add' ? 'rule' : normalizedCommand,
        scope: normalizedCommand === 'add' ? remainder.split(/\s+/u)[0] : '',
        content: normalizedCommand === 'add'
          ? remainder.split(/\s+/u).slice(1).join(' ')
          : remainder,
        slash: true,
      };
    }
    return { action: 'draft', scope: normalizedCommand, content: remainder, slash: true };
  }
  if (CONFIRM_PATTERN.test(text)) return { action: 'confirm' };
  if (CANCEL_PATTERN.test(text)) return { action: 'cancel' };
  const remembered = text.match(REMEMBER_PATTERN) ?? text.match(ROLE_REMEMBER_PATTERN);
  if (remembered) {
    const category = remembered.length > 2 ? remembered[1] : '';
    const content = compact(remembered.length > 2 ? remembered[2] : remembered[1]);
    return content ? {
      action: 'draft',
      kind: category.includes('口癖') || ROLE_REMEMBER_PATTERN.test(text) ? 'phrase' : 'rule',
      content,
    } : { action: 'train' };
  }
  if (/^(?:训练|开始训练)(?:口癖|人格|角色人格)?$/u.test(text)) return { action: 'train' };
  return null;
}

export class QqPersonaManager {
  constructor(options = {}) {
    this.store = options.store;
    this.enabled = options.enabled !== false && Boolean(this.store);
    this.adminUsers = new Set([...(options.adminUsers ?? [])].map((id) => String(id).trim()).filter(Boolean));
    this.globalUsers = new Set([...(options.globalUsers ?? [])].map((id) => String(id).trim()).filter(Boolean));
    this.defaultScope = options.defaultScope === 'global' ? 'global' : 'user';
    this.pendingTtlMs = Number(options.pendingTtlMs ?? 30 * 60 * 1000);
  }

  isAdministrator(userId) {
    const normalized = String(userId ?? '').trim();
    return this.adminUsers.has(normalized) || this.globalUsers.has(normalized);
  }

  canManage(scopeType, scopeId, userId) {
    const actor = String(userId ?? '').trim();
    if (scopeType === 'global' || scopeType === 'group') return this.isAdministrator(actor);
    return actor === String(scopeId ?? '').trim() || this.isAdministrator(actor);
  }

  resolveScope(requestedScope, payload, content = '') {
    const requested = String(requestedScope ?? '').trim().toLowerCase();
    const actor = String(payload.userId ?? '').trim();
    const groupId = String(payload.groupId ?? '').trim();
    // 自然语言“角色习惯/口癖”默认仍是用户专属；只有明确写“全局”或使用
    // /persona global 才能触发全局范围，避免管理员随手训练时误改全局人格。
    const globalHint = /全局/iu.test(content);
    const defaultScope = this.defaultScope === 'global' && this.isAdministrator(actor)
      ? 'global' : 'user';
    const scopeType = requested === 'global' || (!requested && globalHint && this.isAdministrator(actor))
      ? 'global'
      : requested === 'group' || (!requested && groupId && /本群|群里|群聊/iu.test(content))
        ? 'group'
        : requested === 'user' ? 'user' : defaultScope;
    const scopeId = scopeType === 'global' ? 'global' : scopeType === 'group' ? groupId : actor;
    return { scopeType, scopeId };
  }

  formatHelp() {
    return [
      '人格训练已启用。',
      '直接说“记住我的口癖：……”会生成待确认草稿；回复“确认保存”才会生效。',
      '/persona preview 查看待确认内容，/persona cancel 取消。',
      '/persona list 查看当前人格，/persona undo 回退上一版本。',
      '管理员可以用 /persona global …… 保存全局人格；普通用户默认只保存自己的口癖。',
    ].join('\n');
  }

  pendingFor(payload) {
    const cutoff = Date.now() - this.pendingTtlMs;
    return this.store.getPendingForActor(String(payload.userId ?? '').trim(), 5)
      .filter((entry) => entry.createdAt >= cutoff);
  }

  handle(payload) {
    if (!this.enabled || payload?.observeOnly) return null;
    const request = parsePersonaRequest(payload.text);
    if (!request) return null;
    const actor = String(payload.userId ?? '').trim();
    if (!actor) return { handled: true, mode: 'persona-error', messages: [{ type: 'text', text: '无法确认人格训练发起人。' }] };

    if (request.action === 'help' || request.action === 'train') {
      return { handled: true, mode: 'persona-help', messages: [{ type: 'text', text: this.formatHelp() }] };
    }
    if (request.action === 'cancel') {
      const pending = this.pendingFor(payload)[0];
      if (!pending && !request.slash) return null;
      if (!pending) return { handled: true, mode: 'persona-cancelled', messages: [{ type: 'text', text: '现在没有待确认的人格补充。' }] };
      this.store.reject(pending.id, actor);
      return { handled: true, mode: 'persona-cancelled', messages: [{ type: 'text', text: '已取消这条人格补充，普通聊天不会写入人格记忆。' }] };
    }
    if (request.action === 'preview') {
      const pending = this.pendingFor(payload);
      if (!pending.length) return { handled: true, mode: 'persona-preview', messages: [{ type: 'text', text: '没有待确认的人格补充。' }] };
      const text = pending.map((entry) => [
        `待确认 #${entry.id}（${scopeLabel(entry.scopeType, entry.scopeId)}）`,
        profileText(entry.profile),
      ].join('\n')).join('\n\n');
      return { handled: true, mode: 'persona-preview', messages: [{ type: 'text', text }] };
    }
    if (request.action === 'list') {
      const profiles = this.store.getProfilesFor({
        userId: actor,
        groupId: payload.messageType === 'group' ? payload.groupId : '',
      });
      if (!profiles.length) return { handled: true, mode: 'persona-list', messages: [{ type: 'text', text: '当前还没有已确认的人格补充。' }] };
      const text = profiles.map((entry) => [
        `${scopeLabel(entry.scopeType, entry.scopeId)} v${entry.version}`,
        profileText(entry.profile) || '（已停用）',
      ].join('\n')).join('\n\n');
      return { handled: true, mode: 'persona-list', messages: [{ type: 'text', text }] };
    }
    if (request.action === 'draft') {
      const rawContent = request.content || request.scope;
      const profile = parseProfileText(rawContent, request.kind ?? 'rule');
      if (!profile) return { handled: true, mode: 'persona-error', messages: [{ type: 'text', text: '请补充要记住的口癖或表达习惯。' }] };
      const scope = this.resolveScope(request.scope, payload, rawContent);
      if (!scope.scopeId) {
        return { handled: true, mode: 'persona-error', messages: [{ type: 'text', text: '群专属人格需要在群聊里发起。' }] };
      }
      if (!this.canManage(scope.scopeType, scope.scopeId, actor)) {
        return { handled: true, mode: 'persona-denied', messages: [{ type: 'text', text: '全局或群专属人格只能由管理员确认；你可以训练自己的专属口癖。' }] };
      }
      const current = this.store.getActive(scope.scopeType, scope.scopeId);
      const event = this.store.createPending({
        ...scope,
        actorUserId: actor,
        sourceText: payload.text,
        profile: mergeProfiles(current?.profile, profile),
      });
      return {
        handled: true,
        mode: 'persona-pending',
        messages: [{
          type: 'text',
          text: [
            `准备保存为${scopeLabel(scope.scopeType, scope.scopeId)}：`,
            profileText(event.profile),
            '回复“确认保存”或 /persona save 后生效；不确认不会写入长期人格。',
          ].join('\n'),
        }],
      };
    }
    if (request.action === 'confirm') {
      const pending = this.pendingFor(payload)[0];
      if (!pending && !request.slash) return null;
      if (!pending) return { handled: true, mode: 'persona-confirm', messages: [{ type: 'text', text: '没有待确认的人格补充。' }] };
      if (!this.canManage(pending.scopeType, pending.scopeId, actor)) {
        return { handled: true, mode: 'persona-denied', messages: [{ type: 'text', text: '你没有权限确认这条人格补充。' }] };
      }
      const profile = this.store.approve(pending.id, actor);
      return { handled: true, mode: 'persona-confirmed', messages: [{ type: 'text', text: `已保存${scopeLabel(profile.scopeType, profile.scopeId)} v${profile.version}。普通群聊不会覆盖它。` }] };
    }
    if (request.action === 'undo') {
      const scope = this.resolveScope(request.argument, payload, request.argument);
      if (!this.canManage(scope.scopeType, scope.scopeId, actor)) {
        return { handled: true, mode: 'persona-denied', messages: [{ type: 'text', text: '你没有权限回退这条人格配置。' }] };
      }
      const versions = this.store.listVersions(scope.scopeType, scope.scopeId, 3);
      const previous = versions.find((entry) => entry.status !== 'active');
      if (!previous) return { handled: true, mode: 'persona-undo', messages: [{ type: 'text', text: '没有可回退的人格版本。' }] };
      const profile = this.store.revertToVersion(scope.scopeType, scope.scopeId, previous.version, actor);
      return { handled: true, mode: 'persona-undo', messages: [{ type: 'text', text: `已恢复${scopeLabel(profile.scopeType, profile.scopeId)} v${profile.version}，内容来自旧版本 v${previous.version}。` }] };
    }
    if (request.action === 'disable') {
      const scope = this.resolveScope(request.argument, payload, request.argument);
      if (!this.canManage(scope.scopeType, scope.scopeId, actor)) {
        return { handled: true, mode: 'persona-denied', messages: [{ type: 'text', text: '你没有权限停用这条人格配置。' }] };
      }
      const profile = this.store.disable(scope.scopeType, scope.scopeId, actor);
      return { handled: true, mode: 'persona-disabled', messages: [{ type: 'text', text: `已停用${scopeLabel(profile.scopeType, profile.scopeId)}；历史版本仍可用 /persona undo 恢复。` }] };
    }
    return { handled: true, mode: 'persona-help', messages: [{ type: 'text', text: this.formatHelp() }] };
  }

  contextFor(message) {
    if (!this.enabled) return '';
    return this.store.formatContext(this.store.getProfilesFor({
      userId: message?.from?.userid ?? message?.userId ?? '',
      groupId: message?.chattype === 'group' ? message?.chatid ?? message?.groupId : '',
    }));
  }
}
