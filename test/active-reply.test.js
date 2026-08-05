import test from 'node:test';
import assert from 'node:assert/strict';
import { ActiveReplyDecider } from '../src/active-reply.js';

function groupPayload(overrides = {}) {
  return {
    messageType: 'group',
    groupId: 'g1',
    userId: 'u1',
    senderName: '群友甲',
    text: '这个问题有人知道吗',
    forwardedText: '',
    botUserId: 'bot',
    mentions: [],
    quotedAuthor: null,
    hasImage: false,
    pureBotMention: false,
    ...overrides,
  };
}

test('主动回复判定会结合现有人格和近期群聊，AI 返回 yes 时放行', async () => {
  const calls = [];
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete(history, input, options) {
        calls.push({ history, input, options });
        return 'yes';
      },
    },
    enabled: true,
    candidateProbability: 1,
    personaPrompt: '你喜欢互联网文化，但不会抢别人话。',
    now: () => 10_000,
  });

  const result = await decider.shouldReply({
    payload: groupPayload(),
    currentContent: '这个问题有人知道吗',
    history: [
      { role: 'user', content: '群友乙：刚才那个方案不太行' },
      { role: 'assistant', content: '机器人之前说过一句话' },
    ],
  });

  assert.deepEqual(result, { reply: true, reason: 'ai-yes' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].options.systemPrompt, /互联网文化/);
  assert.match(calls[0].options.systemPrompt, /读空气/);
  assert.match(calls[0].input, /最近群聊/);
  assert.match(calls[0].input, /当前消息/);
  assert.deepEqual(calls[0].options.thinking, { type: 'disabled' });
});

test('概率预筛未命中时不花费决策模型调用', async () => {
  let calls = 0;
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { calls += 1; return 'yes'; },
    },
    enabled: true,
    candidateProbability: 0.2,
    random: () => 0.9,
    now: () => 10_000,
  });

  const result = await decider.shouldReply({ payload: groupPayload(), history: [] });

  assert.deepEqual(result, { reply: false, reason: 'probability' });
  assert.equal(calls, 0);
});

test('冷却期与每小时上限会阻止连续主动插话', async () => {
  let currentTime = 100_000;
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { return 'yes'; },
    },
    enabled: true,
    candidateProbability: 1,
    cooldownMs: 1_000,
    maxRepliesPerHour: 2,
    now: () => currentTime,
  });

  const first = await decider.shouldReply({ payload: groupPayload(), history: [] });
  currentTime += 100;
  const cooledDown = await decider.shouldReply({ payload: groupPayload(), history: [] });
  currentTime += 1_000;
  const second = await decider.shouldReply({ payload: groupPayload(), history: [] });
  currentTime += 1_000;
  const limited = await decider.shouldReply({ payload: groupPayload(), history: [] });

  assert.equal(first.reply, true);
  assert.deepEqual(cooledDown, { reply: false, reason: 'cooldown' });
  assert.equal(second.reply, true);
  assert.deepEqual(limited, { reply: false, reason: 'hourly-limit' });
});

test('消息明确发给其他群友、带图片或来自机器人自身时保持沉默', async () => {
  let calls = 0;
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { calls += 1; return 'yes'; },
    },
    enabled: true,
    candidateProbability: 1,
  });

  const payloads = [
    groupPayload({ mentions: [{ userId: 'u2', name: '群友乙' }] }),
    groupPayload({ quotedAuthor: { userId: 'u2', name: '群友乙' } }),
    groupPayload({ hasImage: true }),
    groupPayload({ userId: 'bot' }),
  ];
  const results = await Promise.all(payloads.map((payload) => (
    decider.shouldReply({ payload, history: [] })
  )));

  assert.ok(results.every((result) => result.reason === 'ineligible'));
  assert.equal(calls, 0);
});

test('引用机器人时绕过概率预筛，但决策故障仍安全保持沉默', async () => {
  const warnings = [];
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { throw new Error('上游超时'); },
    },
    enabled: true,
    candidateProbability: 0,
    random: () => 1,
    logger: { warn(message) { warnings.push(message); } },
  });

  const result = await decider.shouldReply({
    payload: groupPayload({ quotedAuthor: { userId: 'bot', name: '机器人' } }),
    history: [],
  });

  assert.deepEqual(result, { reply: false, reason: 'decision-error' });
  assert.match(warnings[0], /默认保持沉默/);
});
