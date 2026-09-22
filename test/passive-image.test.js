import test from 'node:test';
import assert from 'node:assert/strict';
import { Jimp } from 'jimp';
import { QqBotService } from '../src/qq-service.js';
import { ActiveReplyDecider } from '../src/active-reply.js';
import { ConversationStore } from '../src/conversation-store.js';
import { isDenseImageText } from '../src/passive-image.js';

const dense = ['Release 1.2 will be available on September 20. The new version reduces memory usage by 30 percent for Linux systems with at least 8 GB of RAM. Windows support is experimental. Back up the configuration before upgrading and verify compatibility with your plugins.'];
const answer = '图里这次更新说 Linux 内存占用能降 30%，条件是至少 8 GB 内存；Windows 还在实验支持阶段，插件兼容性也得先查。省资源当然香，但别把实验支持看成随便升级，先备份再上。';

async function fixture({ low = false, visionFailed = false } = {}) {
  let now = Date.parse('2026-09-20T11:00:00Z'), ocrCalls = 0;
  const calls = [];
  const chatClient = { isConfigured: true, async complete(_history, input, options) {
    calls.push({ input, options });
    if (options.usageSource === 'active-reply-decision') return 'help';
    if (options.usageSource === 'active-value-gate') return 'speak';
    if (options.usageSource === 'active-image-triage') {
      return JSON.stringify({ candidate: 'yes', summary: '图中列出一次版本升级，Linux 内存占用下降 30%，Windows 支持仍是实验性质。',
        visible_text: ['Linux memory usage reduced by 30 percent', 'Windows support is experimental'],
        keywords: ['Release 1.2'], scene: '版本公告截图' });
    }
    if (options.usageSource === 'image-understanding') {
      if (visionFailed) throw Error('vision unavailable');
      return JSON.stringify({ description: '项目版本更新的公开评论', visible_text: dense,
        search_queries: ['Release 1.2 Linux memory 30 percent'],
        source_candidates: [{ platform: 'Reddit', confidence: 'medium', evidence: 'u/ 名字和上下投票按钮、嵌套回复' }] });
    }
    return answer;
  } };
  const decider = new ActiveReplyDecider({ chatClient, enabled: true, now: () => now, random: () => 1 });
  const searches = [];
  const service = new QqBotService({ chatClient, conversationStore: new ConversationStore(),
    activeReplyDecider: decider, repeatEnabled: false, now: () => now,
    imageOcrEnabled: true, imageOcrRecognizer: async () => { ocrCalls++; return low ? ['哈哈哈'] : dense; },
    webSearchEnabled: true, webSearch: { async search(query, options) {
      searches.push({ query, options });
      return { resultCount: 1, context: '公开原文提到 Linux 内存 30%，8 GB RAM，Windows experimental', results: [] };
    } }, memeStore: { async pick() { return null; } }, logger: { log() {}, warn() {} } });
  const image = (await new Jimp({ width: 64, height: 64, color: 0xffffffff }).getBuffer('image/png')).toString('base64');
  let id = 0;
  return { service, calls, searches, decider, tick(ms) { now += ms; }, ocrCalls: () => ocrCalls,
    send(overrides = {}) { return service.handleMessage({ message_type: 'group', group_id: 'g', user_id: 'u',
      bot_user_id: 'bot', message_id: String(++id), text: '', observe_only: true, image_base64s: [image], ...overrides }); } };
}

test('密集信息图走 OCR→语义→视觉候选平台→检索→人格短评，同图 OCR 只执行一次', async () => {
  const f = await fixture();
  const result = await f.send();
  assert.equal(result.messages[0].text, answer);
  assert.equal(f.ocrCalls(), 1);
  assert.deepEqual(f.searches.map(call => call.options.includeDomains), [['reddit.com'], []]);
  assert.ok(f.decider.getGroupEngagement('g'));
  const prompt = f.calls.find(call => call.options.usageSource === 'active-reply').options;
  assert.match(prompt.additionalSystemPrompt, /保留会改变含义的主体、关键数字及单位/);
  assert.match(prompt.additionalSystemPrompt, /原帖未核实/);
  assert.deepEqual(prompt.thinking, { type: 'disabled' });
  assert.match(prompt.stableSystemPrompt, /100～220/);
  assert.doesNotMatch(prompt.stableSystemPrompt, /只写 1～2 句/);
  const again = await f.send();
  assert.equal(again.messages.length, 0);
  assert.equal(f.ocrCalls(), 1);
});

test('低信息、重复字、其他成员 @、peer 与被引用 Bot 表情包不启动主动识图', async () => {
  assert.equal(isDenseImageText(['哈'.repeat(300)]), false);
  const low = await fixture({ low: true });
  assert.equal((await low.send()).messages.length, 0);
  assert.equal(low.calls.length, 0);
  assert.equal(low.service.lastGroupPassiveDecisionAt.size, 0);
  const f = await fixture();
  await f.send({ mentions: [{ user_id: 'someone-else' }] });
  assert.equal(f.ocrCalls(), 0);
  f.service.peerBotUsers.add('peer');
  await f.send({ user_id: 'peer' });
  assert.equal(f.ocrCalls(), 0);
  await f.send({ image_base64s: [], has_image: true, quoted_user_id: 'bot', quoted_image_base64s: ['not-current'] });
  assert.equal(f.ocrCalls(), 0);
});

test('主动图视觉失败时静默、不搜索、不续期开窗；关闭主动图不影响文字入口', async () => {
  const f = await fixture({ visionFailed: true });
  assert.equal((await f.send()).messages.length, 0);
  assert.equal(f.searches.length, 0);
  assert.equal(f.decider.getGroupEngagement('g'), null);
  const disabled = await fixture();
  disabled.service.passiveImageEnabled = false;
  assert.equal((await disabled.send()).messages.length, 0);
  assert.equal(disabled.ocrCalls(), 0);
  const text = await disabled.send({ image_base64s: [], text: '升级失败了，有什么解决方案？' });
  assert.ok(text.messages.length);
});

test('热聊中的低 OCR 图片进入一次快速视觉筛选，并复用筛选结果完成主动短评', async () => {
  const f = await fixture({ low: true });
  const now = Date.parse('2026-09-20T11:00:00Z');
  f.decider.groupActivity.set('g', [
    { timestamp: now - 3_000, userId: 'u1', isPeerBot: false },
    { timestamp: now - 2_000, userId: 'u2', isPeerBot: false },
    { timestamp: now - 1_000, userId: 'u3', isPeerBot: false },
    { timestamp: now - 500, userId: 'u2', isPeerBot: false },
  ]);
  const result = await f.send({ text: '这个也和刚才讨论的升级有关' });
  assert.equal(result.messages[0].text, answer);
  assert.equal(f.ocrCalls(), 1);
  assert.equal(f.calls.filter(call => call.options.usageSource === 'active-image-triage').length, 1);
  assert.equal(f.calls.filter(call => call.options.usageSource === 'image-understanding').length, 0);
  assert.ok(f.decider.getGroupEngagement('g'));
});
