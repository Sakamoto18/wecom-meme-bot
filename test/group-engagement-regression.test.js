import test from 'node:test';
import assert from 'node:assert/strict';
import { QqBotService } from '../src/qq-service.js';
import { ActiveReplyDecider } from '../src/active-reply.js';
import { ConversationStore } from '../src/conversation-store.js';

function fixture({ peak = false, failReply = false } = {}) {
  let now = Date.parse(peak ? '2026-09-21T02:00:00Z' : '2026-09-20T11:00:00Z');
  let classification = 'help';
  const calls = [], logs = [];
  const chatClient = { isConfigured: true, async complete(history, input, options) {
    calls.push({ history, input, options });
    if (options.usageSource === 'active-reply-decision') return classification;
    if (options.usageSource === 'active-value-gate') return 'skip';
    if (failReply) throw Error('reply unavailable');
    return '先检查目标地址和端口是否一致，再看服务日志中的具体报错。';
  } };
  const decider = new ActiveReplyDecider({ chatClient, enabled: true, now: () => now,
    candidateProbability: 0, questionProbability: 0, engagementReplyProbability: 0,
    logger: { warn() {} }, random: () => 1 });
  const store = new ConversationStore();
  const service = new QqBotService({ chatClient, activeReplyDecider: decider,
    conversationStore: store, now: () => now, repeatEnabled: false,
    largeGroupExcludedIds: new Set(['913546080']),
    webSearchEnabled: false, imageOcrEnabled: false,
    memeStore: { async pick() { return null; } },
    logger: { log(m) { logs.push(m); }, warn() {}, info() {} } });
  const base = { message_type: 'group', group_id: 'g', group_member_count: 150,
    group_member_limit: 500, user_id: 'u1', sender_name: '群友甲', bot_user_id: 'bot', observe_only: true };
  let id = 0;
  return { service, decider, store, calls, logs, tick(ms = 1000) { now += ms; },
    classify(value) { classification = value; },
    send(text, overrides = {}) { return service.handleMessage({ ...base, message_id: String(++id), text, ...overrides }); } };
}

test('热聊主动接入后 observe_only 连续追问三轮，不受峰时采样、概率或十八秒冷却拦截', async () => {
  for (const peak of [false, true]) {
    const f = fixture({ peak });
    const first = await f.send('服务连不上，应该先排哪里？');
    assert.equal(first.active_reply_reason, 'ai-help');
    assert.ok(f.decider.getGroupEngagement('g'));
    f.classify('followup');
    for (const question of ['我试过了还是不行', '？是我说地址错了吗', '那端口在哪改']) {
      f.tick();
      const result = await f.send(question);
      assert.equal(result.active_reply_reason, 'engagement-followup-must');
      assert.ok(result.messages.some(m => m.type === 'text'));
    }
    assert.equal(f.calls.filter(c => c.options.usageSource === 'active-value-gate').length, 0);
    assert.equal(f.decider.getGroupEngagement('g').followupCount, 3);
    const capped = await f.send('还要再补一步');
    assert.equal(capped.messages.length, 0);
    f.tick(6000);
    await f.send('@龙玉涛 再看看日志', { observe_only: false, mentions: [{ user_id: 'bot', name: '龙玉涛' }] });
    f.tick();
    assert.equal((await f.send('那这个错误呢')).active_reply_reason, 'engagement-followup-must');
    assert.ok(f.calls.filter(c => c.options.usageSource === 'active-reply').slice(1).every(c => c.history.length > 0));
  }
});

test('无关、附和、转向他人和停止指令不续期；peer bot 不继承真人窗口', async () => {
  const f = fixture();
  await f.send('这个错误怎么排？');
  const expires = f.decider.getGroupEngagement('g').expiresAt;
  f.tick(); f.classify('no');
  assert.equal((await f.send('哈哈哈哈')).messages.length, 0);
  assert.equal((await f.send('你怎么看', { mentions: [{ user_id: 'u2' }] })).messages.length, 0);
  assert.equal(f.decider.getGroupEngagement('g').expiresAt, expires);
  f.classify('followup');
  f.service.peerBotUsers.add('peer');
  assert.equal((await f.send('继续', { user_id: 'peer' })).messages.length, 0);
  await f.send('不用回复了');
  assert.equal(f.decider.getGroupEngagement('g'), null);
});

test('旁观图片不消耗判定采样；公开问题和多人热聊十五秒后就可判定', async () => {
  const f = fixture(); f.classify('no');
  await f.send('', { has_image: true });
  assert.equal(f.service.lastGroupPassiveDecisionAt.size, 0);
  await f.send('随便聊聊');
  f.tick(16000); f.classify('help');
  assert.equal((await f.send('这个端口错误怎么解决')).active_reply_reason, 'ai-help');
  const g = fixture(); g.classify('no');
  await g.send('我一直连接失败');
  g.tick(5000); await g.send('服务是启动着的', { user_id: 'u2' });
  g.tick(5000); await g.send('地址也对过了');
  g.tick(6000); g.classify('help');
  assert.equal((await g.send('还是连不上，日志也没请求进来', { user_id: 'u2' })).active_reply_reason, 'ai-help');
});

test('实际八十二人、容量五百保持普通群，排除名单优先于强制大型群', () => {
  const { service } = fixture();
  assert.equal(service.isLargeGroup('small', { groupMemberCount: 82, groupMemberLimit: 500 }), false);
  assert.equal(service.isLargeGroup('missing', { groupMemberLimit: 500 }), false);
  assert.equal(service.isLargeGroup('changing', { groupMemberCount: 121 }), true);
  assert.equal(service.isLargeGroup('changing', { groupMemberCount: 120 }), false);
  service.largeGroupIds.add('913546080');
  assert.equal(service.isLargeGroup('913546080', { groupMemberCount: 500 }), false);
});

test('回复生成失败不消耗续聊轮次和窗口时间', async () => {
  const f = fixture({ failReply: true });
  f.decider.openEngagement({ messageType: 'group', groupId: 'g', userId: 'u1' });
  const before = { ...f.decider.getGroupEngagement('g') };
  f.tick(); f.classify('followup');
  await assert.rejects(f.send('那下一步呢'), /reply unavailable/);
  assert.equal(f.decider.getGroupEngagement('g').followupCount, before.followupCount);
  assert.equal(f.decider.getGroupEngagement('g').expiresAt, before.expiresAt);
});

test('引用机器人直接攻击恢复 attack-reply，普通引用和背景里的骂人不触发', async () => {
  const f = fixture();
  const quoted = { observe_only: false, quoted_user_id: 'bot', quoted_text: '行，这次确实看歪了。',
    mentions: [{ user_id: 'bot', name: '龙玉涛' }] };
  await f.send('@龙玉涛 你这个傻逼ai', quoted);
  assert.ok(f.calls.some(c => c.options.usageSource === 'attack-reply'));
  for (const [text, overrides] of [
    ['？是我说的他是小处男吗', {}],
    ['如何评价', { quoted_text: '你这个傻逼ai' }],
    ['这游戏什么垃圾', {}],
    ['你觉得这游戏垃圾吗', {}],
    ['你这个傻逼ai', { quoted_user_id: 'u2' }],
  ]) {
    f.tick(6000); const before = f.calls.length;
    await f.send(text, { ...quoted, ...overrides });
    assert.ok(!f.calls.slice(before).some(c => c.options.usageSource === 'attack-reply'), text);
  }
});
