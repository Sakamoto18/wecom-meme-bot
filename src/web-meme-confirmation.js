import { createHash } from 'node:crypto';
import { formatWebMemeReport } from './web-meme-learning.js';

const norm = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (scope, kind) => `web-meme-${kind}:${digest([scope.chatType, scope.chatType === 'group' ? scope.groupId : scope.userId, scope.userId])}`;
const time = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const state = report => report.saved ? '已入库' : report.status === 'done' ? '待确认' : report.status === 'failed' ? '失败' : '未完成';
const sameScope = (a, b) => a?.chatType === b.chatType && (b.chatType === 'group' ? a.groupId === b.groupId : a.userId === b.userId);
const knowledgeVersion = entry => digest(entry);
const HELP = '先发 /learn-list 查看本会话报告；用 /learn-review #序号 或 /learn-review 梗名 预览。也可 /learn-review 最近 | 只确认的结论。预览后发 /learn-confirm 入库，/learn-cancel 取消。';

export function parseWebMemeManagement(value) {
  const match = String(value ?? '').trim().match(/^\/learn-(list|review|confirm|cancel|report)(?:\s+([\s\S]*))?$/iu);
  if (!match || match[1].toLowerCase() === 'report' && !match[2]) return null;
  return { action: match[1].toLowerCase(), argument: (match[2] || '').trim() };
}

export class WebMemeConfirmation {
  constructor({ store, memeKnowledge, now = Date.now }) { Object.assign(this, { store, memeKnowledge, now }); }

  handle(command, scope, { administrator = false, quotedText = '', quotedMessageId = '' } = {}) {
    const { action, argument } = command;
    if (['review', 'confirm', 'cancel'].includes(action) && !administrator) return '只有已配置的机器人管理员可以确认入库；普通成员可以查看学习报告。';
    if (!this.store || !this.memeKnowledge) return '学习记录或梗库暂不可用。';
    try {
      const reports = this.store.listWebMemeReports(scope);
      const pendingKey = key(scope, 'confirmation');
      if (action === 'cancel') {
        this.store.saveProgress(pendingKey, null);
        return '已取消你的待确认预览，梗库没有改动。';
      }
      if (action === 'confirm') {
        if (argument) return '请先用 /learn-review 预览，再单独发送 /learn-confirm。';
        const pending = this.store.getProgress(pendingKey);
        if (!pending?.reportId || this.now() - pending.at > 10 * 60_000) return '没有有效预览，或已超过 10 分钟；请重新 /learn-review。';
        const report = reports.find(r => r.id === pending.reportId);
        if (!report || digest(report) !== pending.version) return '报告已变化，请重新预览后确认，避免入库内容不一致。';
        if (knowledgeVersion(this.memeKnowledge.lookupExact(report.term)) !== pending.knowledgeVersion) return '这个词的梗库已被其他任务更新，请重新预览再确认覆盖。';
        // Persist intent before the separate knowledge database write; never silently lose audit evidence.
        const auditKey = `web-meme-manual-audit:${report.id}:${digest([scope.userId, pending.at])}`;
        const audit = { reportId: report.id, userId: scope.userId, scope, at: this.now(),
          machineConfidence: report.confidence, claims: pending.claims, status: 'writing' };
        this.store.saveProgress(auditKey, audit);
        const used = new Set(pending.claims.flatMap(c => c.sourceIds || []));
        const sources = (report.sources || []).filter(s => used.has(s.id));
        const saved = this.memeKnowledge.put({ term: report.term, confidence: 'high', lookupSource: 'human-confirmed',
          meaning: pending.meaning, usage: pending.usage, aliases: [],
          sourceUrls: sources.map(s => s.url), sourceDomains: sources.length ? [...new Set(sources.map(s => s.domain))] : ['manual-confirmation'],
        });
        if (!saved) {
          this.store.saveProgress(auditKey, { ...audit, status: 'failed' });
          return '梗库写入失败，未确认成功；可以稍后重试 /learn-confirm。';
        }
        report.saved = true;
        report.manualConfirmation = { ...audit, status: 'saved' };
        try {
          this.store.saveProgress(auditKey, report.manualConfirmation);
          this.store.saveProgress(`web-meme-report:${report.id}`, report);
          const scopeHash = digest({ chatType: scope.chatType, target: scope.chatType === 'group' ? scope.groupId : scope.userId });
          const latestKey = `web-meme-latest:${scopeHash}`;
          if (this.store.getProgress(latestKey)?.id === report.id) this.store.saveProgress(latestKey, report);
          this.store.saveProgress(pendingKey, null);
        } catch { return `「${report.term}」已写入梗库，但确认记录回写失败，请联系维护者核对，不要重复确认。`; }
        return `「${report.term}」已人工确认入库（${pending.claims.length} 条），后续聊天可召回。原机器评分保留，未选中的结论仍未确认。`;
      }
      if (action === 'list') {
        const matched = reports.filter(r => !argument || norm(r.term).includes(norm(argument))).slice(0, 10);
        if (!matched.length) return '本会话没有匹配的学习报告。';
        this.store.saveProgress(key(scope, 'selection'), { at: this.now(), ids: matched.map(r => r.id) });
        return ['本会话学习报告（北京时间）：', ...matched.map((r, i) => `#${i + 1} ${r.term} · ${time(r.startedAt)} · ${state(r)}`),
          '用 /learn-report #1 查看；管理员 /learn-review #1 预览入库。序号固定到你这次列表，30 分钟有效；/learn-list 关键词 可筛选。'].join('\n');
      }
      if (action === 'review') this.store.saveProgress(pendingKey, {});
      const parts = argument.split('|');
      if (parts.length > 2 || action === 'report' && parts.length > 1) return HELP;
      let selector = parts[0].trim();
      let report;
      if (!selector && quotedMessageId) {
        const id = String(quotedText).match(/报告编号：([\da-f-]{36})/iu)?.[1];
        if (!id) return '这条引用无法识别报告，请用 /learn-list 选择序号，或 /learn-review 梗名。';
        report = this.store.getProgress(`web-meme-report:${id}`);
        if (report && !sameScope(report.scope, scope)) report = null;
      } else if (!selector || selector === '最近') report = reports[0];
      else if (/^#\d+$/u.test(selector)) {
        const selection = this.store.getProgress(key(scope, 'selection'));
        if (!selection || this.now() - selection.at > 30 * 60_000) return '列表序号已过期或尚未获取，请先 /learn-list。';
        report = reports.find(r => r.id === selection.ids[Number(selector.slice(1)) - 1]);
      } else {
        const matched = reports.filter(r => norm(r.term) === norm(selector));
        if (matched.length > 1) return `「${selector}」有多份报告，请发 /learn-list ${selector}，按时间选择 #序号。`;
        report = matched[0];
      }
      if (!report) return '找不到本会话的这份报告；请 /learn-list 重新选择。';
      if (!['done', 'failed'].includes(report.status)) return '这份学习尚未完成，暂时不能确认；请用 /learn-status 查进度。';
      if (action === 'report') return formatWebMemeReport(report, this.memeKnowledge.ttlMs);
      const custom = parts[1]?.trim();
      if (parts.length === 2 && (!custom || custom.length < 4 || custom.length > 400)) return '单独确认的结论需 4–400 字，例如 /learn-review #1 | 这段声音属于野兽先辈梗。';
      const claims = custom ? [{ kind: 'meaning', text: custom, sourceIds: [] }]
        : (report.claims || []).filter(c => c.kind === 'meaning' || c.kind === 'usage');
      if (!claims.some(c => c.kind === 'meaning')) return '报告没有可保存的梗义；请用 /learn-review #序号 | 你确认的具体结论。';
      const meaning = claims.filter(c => c.kind === 'meaning').map(c => c.text).join(' ');
      const usage = claims.filter(c => c.kind === 'usage').map(c => c.text);
      if (meaning.length > 500) return '候选梗义过长，请用竖线指定要确认的结论（最多 400 字）。';
      const existing = this.memeKnowledge.lookupExact(report.term);
      this.store.saveProgress(pendingKey, { at: this.now(), reportId: report.id, version: digest(report),
        knowledgeVersion: knowledgeVersion(existing), claims, meaning, usage });
      return [`联网学梗报告：${report.term}`, '人工确认预览（尚未入库）', `学习时间：${time(report.startedAt)}`,
        `原机器评分：${report.confidence || '未完成审核'}`, ...claims.map(c => `${c.kind === 'usage' ? '用法' : '梗义'}：${c.text}`),
        '只保存以上内容；其他候选、出处及疑点不会自动通过。',
        existing ? `将覆盖已有词条：${existing.meaning}\n原用法：${existing.usage.join('；') || '无'}` : '将新增共享梗库词条。',
        '仅本次预览的管理员可在当前会话于 10 分钟内发 /learn-confirm 确认；/learn-cancel 取消。'].join('\n');
    } catch { return '学习记录处理失败，未确认成功；请稍后重新查看报告和预览。'; }
  }
}
