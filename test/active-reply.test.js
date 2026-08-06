import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActiveReplyDecider,
  isAdminStopCommand,
  isExplicitEngagementEnd,
} from '../src/active-reply.js';

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

test('主动回复判定使用中立规则和近期群聊，AI 返回 must 时放行', async () => {
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
  assert.doesNotMatch(calls[0].options.systemPrompt, /互联网文化/);
  assert.match(calls[0].options.systemPrompt, /不加载机器人聊天人格/);
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
    semanticValueGateEnabled: false,
    candidateProbability: 1,
    questionProbability: 1,
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
    semanticValueGateEnabled: false,
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
    semanticValueGateEnabled: false,
    candidateProbability: 1,
    busyWindowMs: 20_000,
    busyMessageCount: 4,
    busySenderCount: 2,
    now: () => currentTime,
    random: () => 0,
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
  const publicQuestion = await decider.shouldReply({
    payload: groupPayload({ userId: 'u1', text: '这个问题到底怎么解决？' }),
    history: [],
  });

  assert.deepEqual(result, { reply: false, reason: 'busy-group' });
  assert.deepEqual(publicQuestion, { reply: true, reason: 'ai-may' });
});

test('机器人发言后连续三条没人接话，may 进入主动静默', async () => {
  let currentTime = 10_000;
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { return 'may'; },
    },
    enabled: true,
    semanticValueGateEnabled: false,
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

test('无人接话退场只暂停一段时间，不会永久关闭主动回复', async () => {
  let currentTime = 10_000;
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { return 'may'; },
    },
    enabled: true,
    semanticValueGateEnabled: false,
    candidateProbability: 1,
    busyMessageCount: 99,
    cooldownMs: 0,
    disengageAfterMessages: 3,
    disengageMs: 10_000,
    now: () => currentTime,
  });
  decider.recordBotReply('g1');

  for (let index = 0; index < 3; index += 1) {
    currentTime += 1_000;
    await decider.shouldReply({
      payload: groupPayload({
        mentions: [{ userId: 'u2', name: '群友乙' }],
      }),
      history: [],
    });
  }
  const disengaged = await decider.shouldReply({ payload: groupPayload(), history: [] });
  currentTime = 20_001;
  const resumed = await decider.shouldReply({ payload: groupPayload(), history: [] });

  assert.deepEqual(disengaged, { reply: false, reason: 'disengaged' });
  assert.deepEqual(resumed, { reply: true, reason: 'ai-may' });
});

test('公开问句使用更高候选概率，普通趣味消息仍使用基础概率', async () => {
  const randomValues = [0.5, 0.5];
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { return 'may'; },
    },
    enabled: true,
    semanticValueGateEnabled: false,
    candidateProbability: 0.3,
    questionProbability: 0.6,
    cooldownMs: 0,
    busyMessageCount: 99,
    disengageAfterMessages: 99,
    random: () => randomValues.shift(),
  });

  const interesting = await decider.shouldReply({ payload: groupPayload(), history: [] });
  const question = await decider.shouldReply({
    payload: groupPayload({ text: '这个东西具体怎么用？' }),
    history: [],
  });

  assert.deepEqual(interesting, { reply: false, reason: 'probability' });
  assert.deepEqual(question, { reply: true, reason: 'ai-may' });
});

test('群级话题窗口允许其他真人承接，但按 18 秒节流且只有实际回复才续期', async () => {
  let currentTime = 10_000;
  const decisionOutputs = ['may', 'may', 'may', 'may'];
  const randomValues = [0.4, 1];
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { return decisionOutputs.shift(); },
    },
    enabled: true,
    semanticValueGateEnabled: false,
    candidateProbability: 0,
    questionProbability: 0,
    cooldownMs: 60_000,
    engagementWindowMs: 100_000,
    engagementReplyCooldownMs: 18_000,
    engagementReplyProbability: 0.6,
    now: () => currentTime,
    random: () => randomValues.shift(),
  });
  const owner = groupPayload({ userId: 'u1', text: '先聊聊这个部署方案' });
  decider.openEngagement(owner);

  currentTime += 18_000;
  const participant = groupPayload({ userId: 'u2', text: '那数据库迁移怎么办？' });
  const joined = await decider.shouldReply({ payload: participant, history: [] });
  currentTime += 1_000;
  const cooledDown = await decider.shouldReply({
    payload: groupPayload({ userId: 'u3', text: '回滚方案也得补吧？' }),
    history: [],
  });
  currentTime += 18_001;
  const ownerFollowup = await decider.shouldReply({
    payload: groupPayload({ userId: 'u1', text: '那具体应该怎么做？' }),
    history: [],
  });
  currentTime += 100_001;
  const expired = await decider.shouldReply({ payload: participant, history: [] });

  assert.deepEqual(joined, { reply: true, reason: 'engagement-group-may' });
  assert.deepEqual(cooledDown, { reply: false, reason: 'engagement-cooldown' });
  assert.deepEqual(ownerFollowup, { reply: true, reason: 'engagement-owner-must' });
  assert.deepEqual(expired, { reply: false, reason: 'probability' });
});

test('群话题中的无关消息保持静默但不替其他参与者关闭话题', async () => {
  let currentTime = 10_000;
  const decisions = ['no', 'may'];
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { return decisions.shift(); },
    },
    enabled: true,
    semanticValueGateEnabled: false,
    candidateProbability: 0,
    questionProbability: 0,
    engagementWindowMs: 100_000,
    engagementReplyCooldownMs: 18_000,
    engagementReplyProbability: 1,
    now: () => currentTime,
  });
  const owner = groupPayload({ userId: 'u1', text: '先聊部署方案' });
  decider.openEngagement(owner);

  currentTime += 18_000;
  const unrelated = await decider.shouldReply({
    payload: groupPayload({ userId: 'u2', text: '今晚吃什么' }),
    history: [],
  });
  const later = await decider.shouldReply({
    payload: groupPayload({ userId: 'u3', text: '这个方案的回滚步骤还没说' }),
    history: [],
  });

  assert.deepEqual(unrelated, { reply: false, reason: 'engagement-unrelated' });
  assert.deepEqual(later, { reply: true, reason: 'engagement-group-may' });
  assert.notEqual(decider.getEngagement(owner), null);
});

test('may 候选按上下文语义价值复核，不维护低信息关键词黑名单', async () => {
  const calls = [];
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete(history, input, options) {
        calls.push({ history, input, options });
        return /发言价值复核器/.test(options.systemPrompt) ? 'skip' : 'may';
      },
    },
    enabled: true,
    candidateProbability: 1,
    questionProbability: 1,
    personaPrompt: '你喜欢毒舌吐槽，看到什么都想骂一句。',
  });
  decider.openEngagement(groupPayload({ userId: 'u1', text: '这个周末能发布吗？' }));

  const result = await decider.shouldReply({
    payload: groupPayload({ userId: 'u2', senderName: '群友乙', text: '能的' }),
    history: [
      { role: 'user', content: '群友甲：这个周末能发布吗？' },
      { role: 'user', content: '群友乙：能的' },
    ],
  });

  assert.deepEqual(result, {
    reply: false,
    reason: 'engagement-semantic-value-skip',
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].options.systemPrompt, /不得按固定关键词、字数或句式/);
  assert.doesNotMatch(calls[1].options.systemPrompt, /毒舌吐槽/);
  assert.match(calls[1].input, /这个周末能发布吗/);
  assert.match(calls[1].input, /复核机器人是否应主动发言/);
});

test('may 候选确有未解决问题和新增价值时通过语义复核', async () => {
  const outputs = ['may', 'speak'];
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { return outputs.shift(); },
    },
    enabled: true,
    candidateProbability: 1,
    cooldownMs: 0,
  });

  const result = await decider.shouldReply({
    payload: groupPayload({ text: '我按刚才步骤试了，还是报同一个错' }),
    history: [
      { role: 'assistant', content: '机器人：先清缓存再重启服务。' },
      { role: 'user', content: '群友甲：我按刚才步骤试了，还是报同一个错' },
    ],
  });

  assert.deepEqual(result, { reply: true, reason: 'ai-may' });
});

test('明确点名或引用机器人绕过 may 的语义复核', async () => {
  let calls = 0;
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { calls += 1; return 'may'; },
    },
    enabled: true,
    candidateProbability: 0,
  });

  const named = await decider.shouldReply({
    payload: groupPayload({
      text: '@龙玉涛 能的',
      mentions: [{ userId: 'bot', name: '龙玉涛' }],
    }),
    history: [],
  });
  const quoted = await decider.shouldReply({
    payload: groupPayload({
      text: '能的',
      quotedAuthor: { userId: 'bot', name: '龙玉涛' },
    }),
    history: [],
  });

  assert.deepEqual(named, { reply: true, reason: 'signal-must' });
  assert.deepEqual(quoted, { reply: true, reason: 'signal-must' });
  assert.equal(calls, 2);
});

test('语义价值复核输出无效或调用失败时默认静默', async () => {
  const warnings = [];
  const outputs = ['may', '不确定', 'may'];
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() {
        const output = outputs.shift();
        if (output === undefined) throw new Error('上游超时');
        return output;
      },
    },
    enabled: true,
    candidateProbability: 1,
    cooldownMs: 0,
    logger: { warn(message) { warnings.push(message); } },
  });

  const invalid = await decider.shouldReply({ payload: groupPayload(), history: [] });
  const failed = await decider.shouldReply({ payload: groupPayload(), history: [] });

  assert.deepEqual(invalid, { reply: false, reason: 'semantic-value-invalid' });
  assert.deepEqual(failed, { reply: false, reason: 'semantic-value-error' });
  assert.match(warnings[0], /默认静默/);
});

test('群级话题窗口按群共享，群级结束不影响其他群', () => {
  const decider = new ActiveReplyDecider({
    chatClient: { isConfigured: true },
    enabled: true,
  });
  const first = groupPayload({ groupId: 'g1', userId: 'u1' });
  const second = groupPayload({ groupId: 'g1', userId: 'u2' });
  const otherGroup = groupPayload({ groupId: 'g2', userId: 'u1' });
  decider.openEngagement(first);
  decider.openEngagement(otherGroup);

  assert.equal(decider.getEngagement(second)?.ownerUserId, 'u1');

  const closed = decider.closeEngagementsForGroup('g1');

  assert.equal(closed, 1);
  assert.equal(decider.getEngagement(first), null);
  assert.equal(decider.getEngagement(second), null);
  assert.notEqual(decider.getEngagement(otherGroup), null);
});

test('普通参与者要求结束只退出本人，发起者结束才关闭整段群话题', async () => {
  let calls = 0;
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { calls += 1; return 'must'; },
    },
    enabled: true,
  });
  const owner = groupPayload({ userId: 'u1' });
  const participant = groupPayload({ userId: 'u2', text: '别再回复我了' });
  decider.openEngagement(owner);

  const participantEnd = await decider.shouldReply({ payload: participant, history: [] });

  assert.deepEqual(participantEnd, {
    reply: false,
    reason: 'engagement-ended-explicitly',
  });
  assert.equal(decider.getEngagement(participant), null);
  assert.notEqual(decider.getEngagement(owner), null);
  const participantLater = await decider.shouldReply({
    payload: groupPayload({ userId: 'u2', text: '那我再说一句相关的' }),
    history: [],
  });
  assert.deepEqual(participantLater, {
    reply: false,
    reason: 'engagement-user-muted',
  });

  const ownerEnd = await decider.shouldReply({
    payload: groupPayload({ userId: 'u1', text: '结束这个话题' }),
    history: [],
  });
  assert.deepEqual(ownerEnd, { reply: false, reason: 'engagement-ended-explicitly' });
  assert.equal(decider.getEngagement(owner), null);
  assert.equal(calls, 0);
});

test('peer Bot 不会继承或续期真人群话题窗口', async () => {
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { return 'may'; },
    },
    enabled: true,
    candidateProbability: 0,
    questionProbability: 0,
    engagementReplyProbability: 1,
  });
  const owner = groupPayload({ userId: 'u1' });
  decider.openEngagement(owner);
  const peer = groupPayload({
    userId: 'peer-bot',
    isPeerBot: true,
    text: '我也要继续聊这个话题',
  });

  const result = await decider.shouldReply({ payload: peer, history: [] });

  assert.deepEqual(result, { reply: false, reason: 'probability' });
  assert.equal(decider.getEngagement(peer), null);
  assert.equal(decider.getEngagement(owner)?.replyCount, 0);
});

test('群话题达到补充上限后，窗口内再次艾特只续期且受短节流', async () => {
  let currentTime = 10_000;
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { return 'may'; },
    },
    enabled: true,
    semanticValueGateEnabled: false,
    engagementReplyCooldownMs: 0,
    engagementMentionCooldownMs: 5_000,
    engagementReplyProbability: 1,
    engagementMaxReplies: 2,
    engagementWindowMs: 100_000,
    now: () => currentTime,
  });
  const owner = groupPayload({
    userId: 'u1',
    text: '@龙玉涛 先聊这个话题',
    mentions: [{ userId: 'bot', name: '龙玉涛' }],
  });
  const participant = groupPayload({ userId: 'u2' });
  decider.openEngagement(owner);

  const first = await decider.shouldReply({ payload: participant, history: [] });
  const second = await decider.shouldReply({ payload: participant, history: [] });
  const limited = await decider.shouldReply({ payload: participant, history: [] });
  currentTime += 5_000;
  const nextMention = groupPayload({
    userId: 'u2',
    text: '@龙玉涛 再补一句',
    mentions: [{ userId: 'bot', name: '龙玉涛' }],
  });
  const admitted = decider.admitDirectMention(nextMention);
  decider.openEngagement(nextMention);
  currentTime += 1_000;
  const burstMention = groupPayload({
    userId: 'u3',
    text: '@龙玉涛 还有我',
    mentions: [{ userId: 'bot', name: '龙玉涛' }],
  });
  const throttled = decider.admitDirectMention(burstMention);
  const state = decider.getEngagement(owner);

  assert.equal(first.reply, true);
  assert.equal(second.reply, true);
  assert.deepEqual(limited, { reply: false, reason: 'engagement-reply-limit' });
  assert.deepEqual(admitted, { reply: true, reason: 'engagement-mention-must' });
  assert.equal(throttled.reply, false);
  assert.equal(throttled.reason, 'engagement-mention-cooldown');
  assert.equal(throttled.retryAfterMs, 4_000);
  assert.equal(state?.replyCount, 2);
  assert.equal(state?.ownerUserId, 'u1');
  assert.equal(state?.participantUserIds.has('u3'), true);
  assert.equal(state?.expiresAt, currentTime + 100_000);
});

test('明确结束指令由程序硬拦截，不依赖模型是否听话', async () => {
  assert.equal(isExplicitEngagementEnd('别再回复我了'), true);
  assert.equal(isExplicitEngagementEnd('不许回复了'), true);
  assert.equal(isExplicitEngagementEnd('不允许再搭理我了'), true);
  assert.equal(isExplicitEngagementEnd('不用回复了，结束这个话题'), true);
  assert.equal(isExplicitEngagementEnd('到此为止'), true);
  assert.equal(isExplicitEngagementEnd('如何实现“停止回复”这个功能？'), false);
  assert.equal(isAdminStopCommand('/stop'), true);
  assert.equal(isAdminStopCommand('/STOP'), true);
  assert.equal(isAdminStopCommand('/stop 其他参数'), false);

  let calls = 0;
  const decider = new ActiveReplyDecider({
    chatClient: {
      isConfigured: true,
      async complete() { calls += 1; return 'must'; },
    },
    enabled: true,
  });
  const payload = groupPayload({ text: '别再回复我了' });
  decider.openEngagement(payload);
  const result = await decider.shouldReply({ payload, history: [] });

  assert.deepEqual(result, { reply: false, reason: 'engagement-ended-explicitly' });
  assert.equal(calls, 0);
  assert.equal(decider.getEngagement(payload), null);
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
    questionProbability: 0,
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
