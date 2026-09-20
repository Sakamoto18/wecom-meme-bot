import test from 'node:test';
import assert from 'node:assert/strict';
import { ActiveReplyDecider } from '../src/active-reply.js';
import { QqBotService } from '../src/qq-service.js';
import { QqMemoryStore } from '../src/qq-memory-store.js';

const payload = (overrides = {}) => ({
  messageType: 'group', groupId: 'g', userId: 'human1', senderName: '群友',
  botUserId: 'self', text: '这次涨价会影响已有订阅', mentions: [], ...overrides,
});

function fixture() {
  let now = 100_000, classification = 'may', value = 'speak';
  const calls = [];
  const chatClient = { isConfigured: true, async complete(history, input, options) {
    calls.push({ history, input, options });
    if (options.usageSource === 'active-reply-decision') return classification;
    if (options.usageSource === 'active-value-gate') {
      if (value instanceof Error) throw value;
      return value;
    }
    return '已有订阅是否涨价，还要看公告中的续费生效日期。';
  } };
  const decider = new ActiveReplyDecider({ chatClient, enabled: true,
    now: () => now, candidateProbability: 0, questionProbability: 0,
    engagementReplyProbability: 0, random: () => 1, logger: { warn() {} } });
  return { decider, calls, chatClient, now: () => now,
    tick(ms) { now += ms; }, classify(v) { classification = v; }, value(v) { value = v; },
    heat(peer = false) {
      for (const userId of ['human1', peer ? 'peer' : 'human2', 'human1']) {
        decider.recordIncomingMessage(payload({ userId, isPeerBot: userId === 'peer' }), now);
      }
    },
    decide(overrides) { return decider.shouldReply({ payload: payload(overrides), history: [] }); },
  };
}

test('真人热聊只有通过价值复核才免随机；空泛、无效输出和复核失败静默', async () => {
  for (const value of ['speak', 'skip', 'nonsense', new Error('timeout')]) {
    const f = fixture(); f.heat(); f.value(value);
    // A prior ignored reply must not indefinitely suppress a useful new topic.
    f.decider.recordBotReply('g', 90_000);
    f.decider.messagesSinceBotReply.set('g', 3);
    const result = await f.decide();
    assert.equal(result.reply, value === 'speak');
    assert.equal(f.calls.filter(c => c.options.usageSource === 'active-value-gate').length, 1);
    if (result.reply) assert.equal(result.reason, 'ai-discussion');
    else assert.match(result.reason, /^semantic-value-/);
  }
});

test('有价值的真人热聊仍受 120 秒冷却和每小时六次上限约束', async () => {
  const f = fixture(); f.heat();
  assert.equal((await f.decide()).reply, true);
  const before = f.calls.length;
  assert.equal((await f.decide()).reason, 'cooldown');
  assert.equal(f.calls.slice(before).filter(c => c.options.usageSource === 'active-value-gate').length, 0);
  for (let i = 1; i < 6; i++) {
    f.tick(120_000); f.heat();
    assert.equal((await f.decide()).reply, true);
  }
  f.tick(120_000); f.heat();
  assert.equal((await f.decide()).reason, 'hourly-limit');
});

test('只有一个真人与其他 bot 发言不算真人热聊，peer 的旧统计仍保留', async () => {
  const f = fixture(); f.heat(true);
  assert.equal((await f.decide()).reason, 'probability');
  assert.equal(f.decider.isBusy('g', f.now()), true);
  assert.equal(f.decider.isBusy('g', f.now(), { humanOnly: true }), false);
  assert.equal(f.calls.some(c => c.options.usageSource === 'active-value-gate'), false);
});

test('peer Bot 不获得真人热聊放宽，普通 may 仍被 busy-group 拦截', async () => {
  const f = fixture(); f.heat();
  assert.equal((await f.decide({ userId: 'peer', isPeerBot: true })).reason, 'busy-group');
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(f.calls[0].options.systemPrompt, /公开引用或 @ 他人的讨论不自动判 no/);
  assert.equal((await f.decide({ userId: 'peer', isPeerBot: true,
    mentions: [{ userId: 'human2' }] })).reason, 'ineligible');
});

test('真人公开引用提供完整关系和引用资料，不把提到机器人名字当点名', async () => {
  const f = fixture(); f.classify('help');
  const message = { text: '龙玉涛之前说端口没问题，现在连接还是失败',
    mentions: [{ userId: 'human2', name: '乙' }],
    quotedAuthor: { userId: 'human2', name: '乙' }, quotedText: '确认过容器监听 127.0.0.1:8080',
    quotedForwardedText: '更早的报错：连接被拒绝' };
  assert.equal((await f.decide(message)).reason, 'ai-help');
  const context = f.calls[0].options.sharedContext;
  assert.match(context, /127\.0\.0\.1:8080/);
  assert.match(context, /更早的报错/);
  assert.match(context, /human2/);
  assert.doesNotMatch(context, /程序信号：当前消息点名了机器人/);
  const g = fixture(); g.classify('no');
  assert.equal((await g.decide(message)).reason, 'ai-no');
  assert.equal(g.decider.getGroupEngagement('g'), null);
  assert.equal((await g.decide({ ...message, text: '你本人怎么看',
    quotedAuthor: { userId: 'self' } })).reason, 'ai-no');
});

test('真人窗口内热聊补充免随机但保留十八秒间隔和停止指令', async () => {
  const f = fixture(); f.decider.openEngagement(payload()); f.heat();
  assert.equal((await f.decide()).reason, 'engagement-cooldown');
  f.tick(18_000);
  const result = await f.decide();
  assert.equal(result.reply, true);
  f.decider.confirmReply(payload(), result);
  assert.equal(f.decider.getGroupEngagement('g').replyCount, 1);
  assert.equal((await f.decide({ text: '别再回复了' })).reason, 'engagement-ended-explicitly');
  assert.equal(f.decider.getGroupEngagement('g'), null);
});

test('服务完整入口中，真人引用热聊通过复核后主动接入，观察上下文保留', async (t) => {
  const f = fixture(); f.classify('no');
  const logs = [];
  const conversationStore = new QqMemoryStore({ databaseFilePath: ':memory:', now: f.now });
  t.after(() => conversationStore.close());
  const service = new QqBotService({ chatClient: f.chatClient, activeReplyDecider: f.decider,
    conversationStore, now: f.now, repeatEnabled: false,
    webSearchEnabled: false, imageOcrEnabled: false,
    memeStore: { async pick() { return null; } },
    logger: { log(m) { logs.push(m); }, warn() {} } });
  const base = { message_type: 'group', group_id: 'g', bot_user_id: 'self', observe_only: true };
  for (let i = 0; i < 3; i++) {
    await service.handleMessage({ ...base, message_id: String(i), user_id: `human${i % 2}`,
      text: ['公告说下月调价', '我现在是年付', '续费规则也有变化'][i] });
    f.tick(5_000);
  }
  f.classify('may');
  const result = await service.handleMessage({ ...base, message_id: '3', user_id: 'human1',
    text: '这看起来年付也会跟着改', quoted_user_id: 'human0', quoted_text: '下月仅调整新订阅价格' });
  assert.equal(result.active_reply_reason, 'ai-discussion');
  assert.ok(result.messages.length);
  assert.ok(f.decider.getGroupEngagement('g'));
  assert.match(f.calls.filter(c => c.options.usageSource === 'active-reply-decision').at(-1).options.sharedContext, /续费规则也有变化/);
  assert.ok(logs.some(l => l.includes('"humanBusy":true') && l.includes('"reason":"ai-discussion"')));
});
