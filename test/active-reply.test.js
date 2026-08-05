import test from 'node:test';
import assert from 'node:assert/strict';
import { ActiveReplyDecider } from '../src/active-reply.js';

function groupPayload(overrides = {}) {
  return {
    messageType: 'group',
    groupId: 'g1',
    userId: 'u1',
    senderName: '群友甲',
    text: '这个话题挺有意思',
    forwardedText: '',
    botUserId: 'bot',
    mentions: [],
    quotedAuthor: null,
    hasImage: false,
    pureBotMention: false,
    ...overrides,
  };
}

test('主动回复判定会结合现有人格和近期群聊，AI 返回 must 时放行', async () => {
  const calls = [];
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete(history, input, options) {
        calls.push({ history, input, options });
        return 'must';
      },
    },
    enabled: true,
    candidateProbability: 0,
    personaPrompt: '你喜欢互联网文化，但不会抢别人话。',
    now: () => 10_000,
  });

  const result = await decider.shouldReply({
    payload: groupPayload(),
    currentContent: '这个话题挺有意思',
    history: [
      { role: 'user', content: '群友乙：刚才那个方案不太行' },
      { role: 'assistant', content: '机器人之前说过一句话' },
    ],
  });

  assert.deepEqual(result, { reply: true, reason: 'ai-must' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].options.systemPrompt, /互联网文化/);
  assert.match(calls[0].options.systemPrompt, /must、may 或 no/);
  assert.match(calls[0].input, /最近群聊/);
  assert.match(calls[0].input, /当前消息/);
  assert.deepEqual(calls[0].options.thinking, { type: 'disabled' });
});

test('概率只筛选 AI 判为 may 的可选插话，不再跳过优先级判断', async () => {
  let calls = 0;
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { calls += 1; return 'may'; },
    },
    enabled: true,
    candidateProbability: 0.2,
    random: () => 0.9,
    now: () => 10_000,
  });

  const result = await decider.shouldReply({ payload: groupPayload(), history: [] });

  assert.deepEqual(result, { reply: false, reason: 'probability' });
  assert.equal(calls, 1);
});

test('must 绕过可选插话的概率、群聊热度、无人接话、冷却和小时上限', async () => {
  let currentTime = 100_000;
  let nextDecision = 'may';
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { return nextDecision; },
    },
    enabled: true,
    candidateProbability: 1,
    cooldownMs: HOUR_FOR_TEST,
    maxRepliesPerHour: 1,
    busyWindowMs: 20_000,
    busyMessageCount: 4,
    busySenderCount: 2,
    disengageAfterMessages: 3,
    now: () => currentTime,
  });

  const first = await decider.shouldReply({ payload: groupPayload(), history: [] });
  assert.deepEqual(first, { reply: true, reason: 'ai-may' });

  for (let index = 0; index < 3; index += 1) {
    currentTime += 100;
    await decider.shouldReply({
      payload: groupPayload({
        userId: index % 2 === 0 ? 'u2' : 'u3',
        mentions: [{ userId: 'someone', name: '其他群友' }],
      }),
      history: [],
    });
  }

  nextDecision = 'must';
  currentTime += 100;
  const result = await decider.shouldReply({
    payload: groupPayload({ text: '这个参数会导致删除生产数据' }),
    history: [],
  });

  assert.deepEqual(result, { reply: true, reason: 'ai-must' });
});

test('may 在冷却期与每小时上限内不会连续主动插话', async () => {
  let currentTime = 100_000;
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { return 'may'; },
    },
    enabled: true,
    candidateProbability: 1,
    cooldownMs: 1_000,
    maxRepliesPerHour: 2,
    busyMessageCount: 99,
    disengageAfterMessages: 99,
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

test('群聊在 20 秒内由多人连续发言时阻止 may 抢话', async () => {
  let currentTime = 10_000;
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { return 'may'; },
    },
    enabled: true,
    candidateProbability: 1,
    busyWindowMs: 20_000,
    busyMessageCount: 4,
    busySenderCount: 2,
    now: () => currentTime,
  });

  for (let index = 0; index < 3; index += 1) {
    await decider.shouldReply({
      payload: groupPayload({
        userId: index % 2 === 0 ? 'u1' : 'u2',
        mentions: [{ userId: 'u3', name: '群友丙' }],
      }),
      history: [],
    });
    currentTime += 1_000;
  }
  const result = await decider.shouldReply({
    payload: groupPayload({ userId: 'u2' }),
    history: [],
  });

  assert.deepEqual(result, { reply: false, reason: 'busy-group' });
});

test('机器人发言后连续三条没人接话，may 进入主动静默', async () => {
  let currentTime = 10_000;
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { return 'may'; },
    },
    enabled: true,
    candidateProbability: 1,
    busyMessageCount: 99,
    disengageAfterMessages: 3,
    now: () => currentTime,
  });
  decider.recordBotReply('g1');

  for (let index = 0; index < 2; index += 1) {
    currentTime += 1_000;
    await decider.shouldReply({
      payload: groupPayload({
        mentions: [{ userId: 'u2', name: '群友乙' }],
      }),
      history: [],
    });
  }
  currentTime += 1_000;
  const result = await decider.shouldReply({ payload: groupPayload(), history: [] });

  assert.deepEqual(result, { reply: false, reason: 'disengaged' });
});

test('点名和引用机器人在判定模型故障时按 must 放行，普通问句保持沉默', async () => {
  const warnings = [];
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { throw new Error('上游超时'); },
    },
    enabled: true,
    candidateProbability: 0,
    botNames: ['龙玉涛'],
    logger: { warn(message) { warnings.push(message); } },
  });

  const payloads = [
    groupPayload({ text: '龙玉涛，这个你怎么看' }),
    groupPayload({ quotedAuthor: { userId: 'bot', name: '龙玉涛' } }),
    groupPayload({ text: '竹知了和玄武之声到底是什么？' }),
  ];
  const results = [];
  for (const payload of payloads) {
    results.push(await decider.shouldReply({ payload, history: [] }));
  }

  assert.ok(results.slice(0, 2).every((result) => (
    result.reply === true && result.reason === 'signal-must'
  )));
  assert.deepEqual(results[2], { reply: false, reason: 'decision-error' });
  assert.equal(warnings.length, 3);
  assert.ok(warnings.slice(0, 2).every((warning) => /强信号按 must 放行/.test(warning)));
  assert.match(warnings[2], /默认保持沉默/);
});

test('强信号不会被模型误判为 no 而漏掉', async () => {
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { return 'no'; },
    },
    enabled: true,
    candidateProbability: 0,
  });

  const result = await decider.shouldReply({
    payload: groupPayload({ text: '龙玉涛，这个到底怎么解决' }),
    history: [],
  });

  assert.deepEqual(result, { reply: true, reason: 'signal-must' });
});

test('普通公开问句属于可选插话，必须经过概率与频率限制', async () => {
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { return 'may'; },
    },
    enabled: true,
    candidateProbability: 0,
    now: () => 10_000,
  });

  const result = await decider.shouldReply({
    payload: groupPayload({ text: '竹知了和玄武之声到底是什么？' }),
    history: [],
  });

  assert.deepEqual(result, { reply: false, reason: 'probability' });
});

test('消息明确发给其他群友、带图片或来自机器人自身时保持沉默但仍计入群聊热度', async () => {
  let calls = 0;
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { calls += 1; return 'must'; },
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
  const results = [];
  for (const payload of payloads) {
    results.push(await decider.shouldReply({ payload, history: [] }));
  }

  assert.ok(results.every((result) => result.reason === 'ineligible'));
  assert.equal(calls, 0);
  assert.equal(decider.groupActivity.get('g1').length, 3);
});

test('同一群的并发判定会串行执行', async () => {
  let activeCalls = 0;
  let maxActiveCalls = 0;
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeCalls -= 1;
        return 'no';
      },
    },
    enabled: true,
  });

  await Promise.all([
    decider.shouldReply({ payload: groupPayload({ userId: 'u1' }), history: [] }),
    decider.shouldReply({ payload: groupPayload({ userId: 'u2' }), history: [] }),
  ]);

  assert.equal(maxActiveCalls, 1);
});

const HOUR_FOR_TEST = 60 * 60 * 1000;
