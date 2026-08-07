import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createQqApiServer } from '../src/qq-api.js';
import { ConversationStore } from '../src/conversation-store.js';
import {
  QqBotService,
  buildQqCompatibleMessage,
  normalizeQqPayload,
} from '../src/qq-service.js';
import { ActiveReplyDecider } from '../src/active-reply.js';

function createMeme(filename = 'longtu.png') {
  return {
    filename,
    extension: filename.endsWith('.gif') ? '.gif' : '.png',
    buffer: Buffer.from('fake-image'),
  };
}

function createService(options = {}) {
  const calls = [];
  const chatClient = options.chatClient ?? {
    isConfigured: true,
    async complete(history, modelInput) {
      calls.push({ history, modelInput });
      return '这是 QQ 回答，蠢货，别搁这装看不懂。';
    },
  };
  const memeStore = options.memeStore ?? {
    async pick() {
      return createMeme();
    },
  };
  const service = new QqBotService({
    chatClient,
    memeStore,
    conversationStore: options.conversationStore ?? new ConversationStore(),
    webSearchEnabled: false,
    longtuLibrary: options.longtuLibrary,
    adminUsers: options.adminUsers,
    protectedRoles: options.protectedRoles,
    activeReplyDecider: options.activeReplyDecider,
    peerBotContinuationDecider: options.peerBotContinuationDecider,
    peerBotUsers: options.peerBotUsers,
    peerBotMaxConsecutiveReplies: options.peerBotMaxConsecutiveReplies,
    peerBotLoopWindowMs: options.peerBotLoopWindowMs,
    now: options.now,
    logger: { log() {}, warn() {} },
  });
  return { service, calls };
}

test('QQ 请求字段会映射到现有消息模型且私聊无需 group_id', () => {
  const payload = normalizeQqPayload({
    message_id: 10,
    message_type: 'private',
    user_id: 20,
    text: ' 你好 ',
    quoted_text: '上一句',
    pure_bot_mention: true,
  });
  const message = buildQqCompatibleMessage(payload);

  assert.equal(payload.text, '你好');
  assert.equal(payload.pureBotMention, true);
  assert.equal(message.chattype, 'single');
  assert.equal(message.from.userid, '20');
  assert.equal(message.quote.text.content, '上一句');
  assert.throws(
    () => normalizeQqPayload({ message_type: 'group', user_id: '20' }),
    /group_id/,
  );
});

test('Bridge 显示出来的纯 At 昵称仍走短回复并拦截客服话术', async () => {
  const input = {
    message_id: 'rendered-at-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: 'u1',
    sender_name: '群友',
    text: '@龙玉涛AI2.0',
    bot_user_id: 'bot-qq',
    mentions: [{ user_id: 'bot-qq', name: '龙玉涛AI2.0' }],
  };
  const payload = normalizeQqPayload(input);
  const { service } = createService({
    chatClient: {
      isConfigured: true,
      async complete() {
        return '嘿！听到呼唤我就来了～有什么想跟我聊聊的吗？尽管开口～';
      },
    },
  });
  const result = await service.handleMessage(input);

  assert.equal(payload.pureBotMention, true);
  assert.equal(result.mode, 'pure-mention');
  assert.equal(result.messages[0].text, '这是草莓🍓，这是蓝莓🍇，遇到我算nm倒霉。');
});

test('明确龙图指令直接返回 Base64 图片且不调用模型', async () => {
  const chatClient = {
    isConfigured: true,
    async complete() {
      throw new Error('不应调用模型');
    },
  };
  const { service } = createService({ chatClient });
  const result = await service.handleMessage({
    message_id: 'm1',
    message_type: 'group',
    group_id: 'g1',
    user_id: 'u1',
    sender_name: '小明',
    text: '来张龙图',
    has_image: false,
  });

  assert.equal(result.mode, 'longtu');
  assert.equal(result.messages[0].type, 'image');
  assert.equal(
    Buffer.from(result.messages[0].base64, 'base64').toString(),
    'fake-image',
  );
});

test('QQ 普通对话复用回复引擎、昵称和独立会话记忆并附图', async () => {
  const { service, calls } = createService();
  const input = {
    message_id: 'm2',
    message_type: 'group',
    group_id: '10001',
    user_id: '20002',
    sender_name: 'QQ 小明',
    text: '你好',
    has_image: false,
  };

  const first = await service.handleMessage(input);
  const second = await service.handleMessage({ ...input, message_id: 'm3', text: '还记得吗' });

  assert.deepEqual(first.messages.map((message) => message.type), ['text', 'image']);
  assert.equal(first.messages[0].text, '这是 QQ 回答，蠢货，别搁这装看不懂。');
  assert.match(calls[0].modelInput, /发言人：QQ 小明/);
  assert.equal(calls[1].history.length, 2);
  assert.match(calls[1].history[0].content, /当前消息：你好/);
  assert.equal(second.messages[0].text, '这是 QQ 回答，蠢货，别搁这装看不懂。');
});

test('QQ 纯艾特标记会传入快速人格模式并拦截客服式回复', async () => {
  const calls = [];
  const { service } = createService({
    chatClient: {
      isConfigured: true,
      async complete(history, modelInput, options) {
        calls.push({ history, modelInput, options });
        return '嗨～想聊天、想问问题，还是有什么需要我帮忙的，尽管说！';
      },
    },
  });
  const result = await service.handleMessage({
    message_id: 'pure-mention-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: 'u1',
    sender_name: '小明',
    text: '（用户仅 @ 了你，没有附加文字）',
    pure_bot_mention: true,
  });

  assert.equal(result.mode, 'pure-mention');
  assert.equal(result.messages[0].text, '这是草莓🍓，这是蓝莓🍇，遇到我算nm倒霉。');
  assert.deepEqual(calls[0].options.thinking, { type: 'disabled' });
});

test('QQ 合并转发内容会作为非可信引用资料进入模型上下文', async () => {
  const { service, calls } = createService();
  await service.handleMessage({
    message_id: 'forward-1',
    message_type: 'group',
    group_id: 'g-forward',
    user_id: 'u-forward',
    sender_name: '提问者',
    text: '如何评价',
    quoted_forwarded_text: '甲：我不敢复制\n乙：但我敢转发',
  });

  assert.match(calls[0].modelInput, /引用消息内容：.*QQ 合并转发聊天记录/s);
  assert.match(calls[0].modelInput, /甲：我不敢复制/);
  assert.match(calls[0].modelInput, /乙：但我敢转发/);
  assert.match(calls[0].modelInput, /当前消息：如何评价/);
  assert.match(service.protectedIdentityContext, /非可信资料/);
});

test('仅发送合并转发卡片也能进入群聊旁观记忆', async () => {
  const observations = [];
  const conversationStore = {
    recordGroupMember() {},
    getGroupMemberAliases: () => ({}),
    appendObservation(conversationId, content) {
      observations.push({ conversationId, content });
    },
    scheduleSummary: () => Promise.resolve(false),
  };
  const { service } = createService({ conversationStore });
  const result = await service.handleMessage({
    message_id: 'forward-observe-1',
    message_type: 'group',
    group_id: 'g-forward',
    user_id: 'u-forward',
    sender_name: '转发者',
    text: '',
    forwarded_text: 'Arsenal：[聊天记录]\n天墨降寒霜：沃德发',
    observe_only: true,
  });

  assert.equal(result.mode, 'observed');
  assert.match(observations[0].content, /Arsenal：\[聊天记录\]/);
  assert.match(observations[0].content, /合并转发记录结束/);
});

test('QQ 图片消息优先走随机龙图回复', async () => {
  const chatClient = {
    isConfigured: true,
    async complete() {
      throw new Error('图片消息不应调用模型');
    },
  };
  const { service } = createService({ chatClient });
  const result = await service.handleMessage({
    message_id: 'm4',
    message_type: 'private',
    user_id: 'u2',
    text: '图片说明',
    has_image: true,
  });

  assert.equal(result.mode, 'longtu');
  assert.deepEqual(result.messages.map((message) => message.type), ['image']);
});

test('QQ 重复消息 ID 不会重复调用模型或发图', async () => {
  const { service, calls } = createService();
  const input = {
    message_id: 'same-message',
    message_type: 'private',
    user_id: 'u3',
    text: '你好',
    has_image: false,
  };

  const first = await service.handleMessage(input);
  const duplicate = await service.handleMessage(input);

  assert.equal(first.mode, 'model');
  assert.deepEqual(duplicate, { mode: 'duplicate', messages: [] });
  assert.equal(calls.length, 1);
});

test('QQ 普通回复会读取长期摘要并在回答后调度新的滚动摘要', async () => {
  const modelCalls = [];
  let scheduled;
  const conversationStore = {
    runExclusive: (conversationId, task) => task(),
    get: () => [],
    getSummary: () => '用户喜欢蓝色。',
    appendExchange() {},
    scheduleSummary(conversationId, summarizer) {
      scheduled = { conversationId, summarizer };
      return Promise.resolve(false);
    },
  };
  const chatClient = {
    isConfigured: true,
    async complete(history, modelInput, options) {
      modelCalls.push({ history, modelInput, options });
      return options?.systemPrompt
        ? '更新后的长期摘要'
        : '我记得你喜欢蓝色，笨蛋才会转头就忘。';
    },
  };
  const { service } = createService({ chatClient, conversationStore });

  await service.handleMessage({
    message_id: 'memory-1',
    message_type: 'private',
    user_id: 'u-memory',
    text: '你记得我吗',
    has_image: false,
  });

  assert.match(modelCalls[0].options.additionalSystemPrompt, /用户喜欢蓝色/);
  assert.equal(scheduled.conversationId, 'single:u-memory');
  const summary = await scheduled.summarizer({
    previousSummary: '用户喜欢蓝色。',
    messages: [
      { role: 'user', content: '我还喜欢绿色。' },
      { role: 'assistant', content: '记住了。' },
    ],
  });
  assert.equal(summary, '更新后的长期摘要');
  assert.match(modelCalls[1].options.systemPrompt, /QQ 对话长期记忆整理器/);
  assert.match(modelCalls[1].modelInput, /<previous_summary>/);
  assert.match(modelCalls[1].modelInput, /我还喜欢绿色/);
});

test('相关成员画像和越过近期窗口的历史原文会按需注入回答', async () => {
  const conversationStore = {
    recordGroupMember() {},
    getGroupMembers: () => [],
    getGroupMemberAliases: () => ({}),
    getGroupMemberMemories: () => [{
      userId: 'u-memory',
      speakerId: 'abc123',
      name: '小蓝',
      memory: '稳定偏好：喜欢蓝色；平时写前端。',
    }],
    getGroupMemberHistory: () => [{
      content: '当前发言人：小蓝（成员-abc123）\n当前消息：我养了一只猫',
    }],
    runExclusive: (_conversationId, task) => task(),
    get: () => [],
    getSummary: () => '',
    appendExchange() {},
    scheduleSummary: () => Promise.resolve(false),
  };
  const { service, calls } = createService({ conversationStore });
  await service.handleMessage({
    message_id: 'member-memory-1',
    message_type: 'group',
    group_id: 'g-memory',
    user_id: 'u-memory',
    sender_name: '小蓝',
    text: '你还记得我之前说过什么吗',
  });

  assert.match(calls[0].modelInput, /相关群成员的独立持久画像/);
  assert.match(calls[0].modelInput, /喜欢蓝色；平时写前端/);
  assert.match(calls[0].modelInput, /按相关成员定位到的较早群聊原文/);
  assert.match(calls[0].modelInput, /我养了一只猫/);
  assert.match(calls[0].modelInput, /当前消息：你还记得我之前说过什么吗/);
});

test('无关成员回复隔离其他人的受保护头衔并记录机器人当轮回复对象', async () => {
  const calls = [];
  const exchanges = [];
  const memberObservations = [];
  const conversationStore = {
    recordGroupMember() {},
    getGroupMembers: () => [],
    getGroupMemberAliases: () => ({}),
    appendMemberObservation(groupId, userId, content) {
      memberObservations.push({ groupId, userId, content });
      return false;
    },
    getGroupMemberMemories: () => [{
      userId: 'u-han',
      speakerId: 'abc123',
      name: '【群最鶸】韩潇玟',
      memory: '- 自称“龙王”，群内地位高。\n- 平时玩原神。',
    }],
    getGroupMemberHistory: () => [],
    runExclusive: (_conversationId, task) => task(),
    get: () => [
      { role: 'assistant', content: '你是至高无上的真龙王。' },
      { role: 'user', content: '当前发言人：别的群友（成员-deadbe）\n当前消息：上一句话' },
    ],
    getSummary: () => '- 韩潇玟自称龙王。\n- 群里最近在讨论原神。',
    appendExchange(...args) {
      exchanges.push(args);
    },
    scheduleSummary: () => Promise.resolve(false),
  };
  const chatClient = {
    isConfigured: true,
    async complete(history, modelInput, options) {
      calls.push({ history, modelInput, options });
      return '账号数据在服务器，重新登录原账号即可恢复。连云存档都分不清，你这脑子真是摆设。';
    },
  };
  const { service } = createService({
    chatClient,
    conversationStore,
    protectedRoles: new Map([['u-owner', '至高无上的真龙王']]),
  });

  const result = await service.handleMessage({
    message_id: 'protected-scope-unrelated-1',
    message_type: 'group',
    group_id: 'g-role-scope',
    user_id: 'u-han',
    sender_name: '【群最鶸】韩潇玟',
    text: '卸载原神被贡献清零了怎么办',
  });

  assert.doesNotMatch(calls[0].modelInput, /龙王/);
  assert.match(calls[0].modelInput, /平时玩原神/);
  assert.doesNotMatch(calls[0].history.map((entry) => entry.content).join('\n'), /龙王/);
  assert.doesNotMatch(calls[0].options.additionalSystemPrompt, /真龙王/);
  assert.match(calls[0].options.additionalSystemPrompt, /群聊历史中属于其他成员/);
  assert.match(memberObservations[0].content, /当前发言人：【群最鶸】韩潇玟/);
  assert.match(exchanges[0][2], /本轮回复对象：【群最鶸】韩潇玟/);
  assert.doesNotMatch(result.messages[0].text, /龙王/);
});

test('模型仍把受保护头衔安给无关成员时会强制纠错', async () => {
  const calls = [];
  const chatClient = {
    isConfigured: true,
    async complete(history, modelInput, options) {
      calls.push({ history, modelInput, options });
      if (/受保护身份归属纠错/.test(options.additionalSystemPrompt ?? '')) {
        return '原神账号数据在服务器，重装后重新登录原账号即可。连云存档都分不清，你这脑子真是摆设。';
      }
      return '原神账号数据在服务器，重装后重新登录就行。顶着“龙王”头衔问这种问题，你脑子真是摆设。';
    },
  };
  const { service } = createService({
    chatClient,
    protectedRoles: new Map([['u-owner', '至高无上的真龙王']]),
  });

  const result = await service.handleMessage({
    message_id: 'protected-role-rewrite-1',
    message_type: 'group',
    group_id: 'g-role-scope',
    user_id: 'u-han',
    sender_name: '【群最鶸】韩潇玟',
    text: '卸载原神被贡献清零了怎么办',
  });

  assert.ok(calls.length >= 2);
  assert.ok(calls.some((call) => (
    /受保护身份归属纠错/.test(call.options.additionalSystemPrompt ?? '')
  )));
  assert.doesNotMatch(result.messages[0].text, /龙王/);
  assert.match(result.messages[0].text, /重新登录原账号/);
});

test('成员画像观察保留提及对象且非所有者不会继承受保护头衔', async () => {
  const observations = [];
  const summaryCalls = [];
  let memberSummarizer;
  const conversationStore = {
    recordGroupMember() {},
    getGroupMembers: () => [],
    getGroupMemberAliases: () => ({}),
    appendMemberObservation(groupId, userId, content) {
      observations.push({ groupId, userId, content });
      return true;
    },
    scheduleMemberMemory(_groupId, _userId, summarizer) {
      memberSummarizer = summarizer;
      return Promise.resolve(false);
    },
    appendObservation() {},
    scheduleSummary: () => Promise.resolve(false),
  };
  const chatClient = {
    isConfigured: true,
    async complete(history, modelInput, options) {
      summaryCalls.push({ history, modelInput, options });
      return '- 平时玩原神。';
    },
  };
  const { service } = createService({
    chatClient,
    conversationStore,
    protectedRoles: new Map([['u-owner', '至高无上的真龙王']]),
  });

  await service.handleMessage({
    message_id: 'member-role-observation-1',
    message_type: 'group',
    group_id: 'g-role-scope',
    user_id: 'u-han',
    sender_name: '【群最鶸】韩潇玟',
    text: '龙王说可以关人吗',
    mentions: [{ user_id: 'u-owner', name: '真正的龙玉涛' }],
    observe_only: true,
  });

  assert.match(observations[0].content, /当前发言人：【群最鶸】韩潇玟/);
  assert.match(observations[0].content, /本条消息指向或提到的群成员：至高无上的真龙王/);
  assert.equal(typeof memberSummarizer, 'function');
  await memberSummarizer({
    userId: 'u-han',
    speakerId: 'abc123',
    currentName: '【群最鶸】韩潇玟',
    previousMemory: '- 自称“龙王”，群内地位高。',
    observations: [observations[0].content],
  });
  assert.match(summaryCalls[0].options.systemPrompt, /当前整理对象不是这些受保护头衔的所有者/);
  assert.match(summaryCalls[0].options.systemPrompt, /若已有画像存在这种错误归属，本轮必须删除/);
});

test('QQ 普通群消息只进入观察记忆，不调用模型也不回复', async () => {
  const observations = [];
  const members = [];
  const conversationStore = {
    recordGroupMember(groupId, userId, name, options) {
      members.push({ groupId, userId, name, options });
    },
    getGroupMemberAliases: () => ({}),
    appendObservation(conversationId, content) {
      observations.push({ conversationId, content });
    },
    scheduleSummary: () => Promise.resolve(false),
  };
  const chatClient = {
    isConfigured: true,
    async complete() {
      throw new Error('观察消息不应调用模型');
    },
  };
  const { service } = createService({ conversationStore, chatClient });
  const result = await service.handleMessage({
    message_id: 'observe-1',
    message_type: 'group',
    group_id: 'g-role',
    user_id: 'u-sender',
    sender_name: '群友甲',
    text: '@群友乙 这是个串子',
    mentions: [{ user_id: 'u-target', name: '群友乙' }],
    observe_only: true,
  });

  assert.deepEqual(result, { mode: 'observed', messages: [] });
  assert.equal(observations[0].conversationId, 'group:g-role');
  assert.match(observations[0].content, /当前发言人：群友甲/);
  assert.match(observations[0].content, /群友乙/);
  assert.equal(members.length, 2);
});

test('回答群友的短消息经上下文语义复核后不会误触发回复链路', async () => {
  const calls = [];
  const chatClient = {
    isConfigured: true,
    async complete(history, input, options) {
      calls.push({ history, input, options });
      return /发言价值复核器/.test(options.systemPrompt) ? 'skip' : 'may';
    },
  };
  const activeReplyDecider = new ActiveReplyDecider({
    chatClient,
    enabled: true,
    candidateProbability: 1,
    questionProbability: 1,
  });
  const { service } = createService({ chatClient, activeReplyDecider });

  const result = await service.handleMessage({
    message_id: 'low-information-active-1',
    message_type: 'group',
    group_id: 'g-low-information',
    user_id: 'u-low-information',
    sender_name: '群友甲',
    text: '能的',
    observe_only: true,
  });

  assert.deepEqual(result, { mode: 'observed', messages: [] });
  assert.equal(calls.length, 2);
  assert.match(calls[0].options.systemPrompt, /读空气/);
  assert.match(calls[1].options.systemPrompt, /发言价值复核器/);
});

test('普通群消息经读空气判定命中后复用现有人格回复引擎', async () => {
  const decisions = [];
  const recordedBotReplies = [];
  const { service, calls } = createService({
    activeReplyDecider: {
      async shouldReply(input) {
        decisions.push(input);
        return { reply: true, reason: 'ai-must' };
      },
      recordBotReply(groupId) {
        recordedBotReplies.push(groupId);
      },
    },
  });
  const result = await service.handleMessage({
    message_id: 'active-reply-1',
    message_type: 'group',
    group_id: 'g-active',
    user_id: 'u-active',
    sender_name: '群友甲',
    text: '竹知了和玄武之声到底是什么',
    observe_only: true,
  });

  assert.equal(decisions.length, 1);
  assert.match(decisions[0].currentContent, /竹知了和玄武之声/);
  assert.equal(calls.length, 1);
  assert.equal(result.active_reply, true);
  assert.equal(result.active_reply_priority, 'must');
  assert.deepEqual(result.messages.map((message) => message.type), ['text', 'image']);
  assert.deepEqual(recordedBotReplies, ['g-active']);
});

test('真人艾特后开启群级话题窗口，其他真人相关发言选择性接入并受群级节流', async () => {
  let currentTime = 10_000;
  const replyCalls = [];
  const chatClient = {
    isConfigured: true,
    async complete(history, modelInput, options) {
      if (/发言价值复核器/.test(options?.systemPrompt)) return 'speak';
      if (options?.maxTokens === 8) return 'may';
      replyCalls.push({ history, modelInput, options });
      return '具体做法我给你说明白，省得你又把简单事折腾成事故现场。';
    },
  };
  const activeReplyDecider = new ActiveReplyDecider({
    chatClient,
    enabled: true,
    candidateProbability: 0,
    questionProbability: 0,
    cooldownMs: 60_000,
    engagementWindowMs: 100_000,
    engagementReplyCooldownMs: 18_000,
    engagementReplyProbability: 1,
    now: () => currentTime,
  });
  const { service } = createService({
    chatClient,
    activeReplyDecider,
    now: () => currentTime,
  });
  const directMention = {
    message_id: 'engagement-direct-1',
    message_type: 'group',
    group_id: 'g-engagement',
    user_id: 'human',
    sender_name: '真人',
    text: '@龙玉涛 先说说这个方案',
    bot_user_id: 'longtu-bot',
    mentions: [{ user_id: 'longtu-bot', name: '龙玉涛' }],
  };

  const first = await service.handleMessage(directMention);
  currentTime += 18_000;
  const participantFollowup = await service.handleMessage({
    message_id: 'engagement-followup-1',
    message_type: 'group',
    group_id: 'g-engagement',
    user_id: 'human-2',
    sender_name: '真人二号',
    text: '这个方案的数据库具体怎么迁移？',
    bot_user_id: 'longtu-bot',
    observe_only: true,
  });
  currentTime += 1_000;
  const throttled = await service.handleMessage({
    message_id: 'engagement-followup-2',
    message_type: 'group',
    group_id: 'g-engagement',
    user_id: 'human-3',
    sender_name: '真人三号',
    text: '那回滚流程呢？',
    bot_user_id: 'longtu-bot',
    observe_only: true,
  });
  currentTime += 18_000;
  const ownerFollowup = await service.handleMessage({
    message_id: 'engagement-owner-followup-1',
    message_type: 'group',
    group_id: 'g-engagement',
    user_id: 'human',
    sender_name: '真人',
    text: '最后应该按什么顺序执行？',
    bot_user_id: 'longtu-bot',
    observe_only: true,
  });
  const callsBeforeEnd = replyCalls.length;
  const ended = await service.handleMessage({
    message_id: 'engagement-end-1',
    message_type: 'group',
    group_id: 'g-engagement',
    user_id: 'human',
    sender_name: '真人',
    text: '@龙玉涛 不用回复了，结束这个话题',
    bot_user_id: 'longtu-bot',
    mentions: [{ user_id: 'longtu-bot', name: '龙玉涛' }],
  });
  const afterEnd = await service.handleMessage({
    message_id: 'engagement-after-end-1',
    message_type: 'group',
    group_id: 'g-engagement',
    user_id: 'human',
    sender_name: '真人',
    text: '那再问一句？',
    bot_user_id: 'longtu-bot',
    observe_only: true,
  });

  assert.equal(first.messages.length > 0, true);
  assert.equal(participantFollowup.active_reply, true);
  assert.equal(participantFollowup.active_reply_priority, 'may');
  assert.deepEqual(throttled, { mode: 'observed', messages: [] });
  assert.equal(ownerFollowup.active_reply, true);
  assert.equal(ownerFollowup.active_reply_priority, 'must');
  assert.deepEqual(ended, { mode: 'observed', messages: [] });
  assert.deepEqual(afterEnd, { mode: 'observed', messages: [] });
  assert.equal(replyCalls.length, callsBeforeEnd);
  assert.equal(activeReplyDecider.getEngagement({
    messageType: 'group',
    groupId: 'g-engagement',
    userId: 'human',
  }), null);
});

test('群话题窗口内连续艾特按群短节流且不会重置发起者和计数', async () => {
  let currentTime = 10_000;
  let replyCalls = 0;
  const chatClient = {
    isConfigured: true,
    async complete() {
      replyCalls += 1;
      return '知道了，别挤，一个个说。';
    },
  };
  const activeReplyDecider = new ActiveReplyDecider({
    chatClient,
    enabled: true,
    engagementWindowMs: 100_000,
    engagementMentionCooldownMs: 5_000,
    now: () => currentTime,
  });
  const { service } = createService({
    chatClient,
    activeReplyDecider,
    now: () => currentTime,
  });
  const mention = (messageId, userId, text) => ({
    message_id: messageId,
    message_type: 'group',
    group_id: 'g-mention-cooldown',
    user_id: userId,
    sender_name: userId,
    text,
    bot_user_id: 'longtu-bot',
    mentions: [{ user_id: 'longtu-bot', name: '龙玉涛' }],
  });

  const first = await service.handleMessage(
    mention('mention-cooldown-1', 'human-1', '@龙玉涛 先听我说'),
  );
  const callsAfterFirst = replyCalls;
  currentTime += 1_000;
  const burst = await service.handleMessage(
    mention('mention-cooldown-2', 'human-2', '@龙玉涛 我也要说'),
  );
  const callsAfterBurst = replyCalls;
  currentTime += 4_000;
  const admitted = await service.handleMessage(
    mention('mention-cooldown-3', 'human-2', '@龙玉涛 现在轮到我了吧'),
  );
  const callsAfterAdmitted = replyCalls;
  const stateBeforeEnd = activeReplyDecider.getGroupEngagement(
    'g-mention-cooldown',
  );
  currentTime += 1_000;
  const ended = await service.handleMessage(
    mention('mention-cooldown-end', 'human-1', '@龙玉涛 结束这个话题'),
  );

  assert.equal(first.messages.length > 0, true);
  assert.deepEqual(burst, { mode: 'observed', messages: [] });
  assert.equal(admitted.messages.length > 0, true);
  assert.equal(callsAfterBurst, callsAfterFirst);
  assert.equal(callsAfterAdmitted > callsAfterBurst, true);
  assert.equal(stateBeforeEnd?.ownerUserId, 'human-1');
  assert.equal(stateBeforeEnd?.replyCount, 0);
  assert.equal(stateBeforeEnd?.participantUserIds.has('human-2'), true);
  assert.equal(stateBeforeEnd?.expiresAt, 115_000);
  assert.deepEqual(ended, { mode: 'observed', messages: [] });
  assert.equal(replyCalls, callsAfterAdmitted);
  assert.equal(activeReplyDecider.getGroupEngagement('g-mention-cooldown'), null);
});

test('peer Bot 明确艾特不会开启真人接管窗口', async () => {
  let engagementOpens = 0;
  const { service } = createService({
    peerBotUsers: new Set(['peer-bot']),
    activeReplyDecider: {
      recordBotReply() {},
      openEngagement() { engagementOpens += 1; },
    },
  });

  const result = await service.handleMessage({
    message_id: 'peer-no-engagement-1',
    message_type: 'group',
    group_id: 'g-peer-no-engagement',
    user_id: 'peer-bot',
    sender_name: '另一个机器人',
    text: '@龙玉涛 继续聊',
    bot_user_id: 'longtu-bot',
    mentions: [{ user_id: 'longtu-bot', name: '龙玉涛' }],
  });

  assert.equal(result.messages.length > 0, true);
  assert.equal(engagementOpens, 0);
});

test('超级管理员自然语言结束指令优先关闭全群真人窗口并熔断所有 peer Bot', async () => {
  const activeReplyDecider = new ActiveReplyDecider({
    chatClient: { isConfigured: true },
    enabled: true,
  });
  const firstHuman = {
    messageType: 'group', groupId: 'g-admin-stop', userId: 'human-1',
  };
  const secondHuman = {
    messageType: 'group', groupId: 'g-admin-stop', userId: 'human-2',
  };
  activeReplyDecider.openEngagement(firstHuman);
  activeReplyDecider.openEngagement(secondHuman);
  const { service, calls } = createService({
    activeReplyDecider,
    adminUsers: new Set(['admin']),
    peerBotUsers: new Set(['peer-a', 'peer-b']),
    peerBotMaxConsecutiveReplies: 2,
  });

  const result = await service.handleMessage({
    message_id: 'admin-stop-all-1',
    message_type: 'group',
    group_id: 'g-admin-stop',
    user_id: 'admin',
    sender_name: '超级管理员',
    text: '不许回复了',
    bot_user_id: 'longtu-bot',
  });

  assert.deepEqual(result, { mode: 'observed', messages: [] });
  assert.equal(calls.length, 0);
  assert.equal(activeReplyDecider.getEngagement(firstHuman), null);
  assert.equal(activeReplyDecider.getEngagement(secondHuman), null);
  const paused = await activeReplyDecider.shouldReply({
    payload: {
      messageType: 'group',
      groupId: 'g-admin-stop',
      userId: 'human-1',
      senderName: '真人',
      text: '那还继续说吗？',
      forwardedText: '',
      botUserId: 'longtu-bot',
      mentions: [],
      quotedAuthor: null,
      hasImage: false,
      pureBotMention: false,
    },
    history: [],
  });
  assert.deepEqual(paused, { reply: false, reason: 'admin-paused' });
  for (const userId of ['peer-a', 'peer-b']) {
    assert.equal(service.peerBotReplyLimitReached({
      messageType: 'group', groupId: 'g-admin-stop', userId,
    }), true);
  }
  service.resetPeerBotRepliesForGroup('g-admin-stop');
  assert.equal(service.peerBotReplyLimitReached({
    messageType: 'group', groupId: 'g-admin-stop', userId: 'peer-a',
  }), true);

  await service.handleMessage({
    message_id: 'admin-stop-human-observation-1',
    message_type: 'group',
    group_id: 'g-admin-stop',
    user_id: 'human-3',
    sender_name: '真人三号',
    text: '我先说一句普通群聊',
    bot_user_id: 'longtu-bot',
    observe_only: true,
  });
  assert.equal(service.peerBotReplyLimitReached({
    messageType: 'group', groupId: 'g-admin-stop', userId: 'peer-b',
  }), true);

  const restarted = await service.handleMessage({
    message_id: 'admin-stop-new-engagement-1',
    message_type: 'group',
    group_id: 'g-admin-stop',
    user_id: 'human-3',
    sender_name: '真人三号',
    text: '@龙玉涛 开个新话题',
    bot_user_id: 'longtu-bot',
    mentions: [{ user_id: 'longtu-bot', name: '龙玉涛' }],
  });
  assert.equal(restarted.messages.length > 0, true);
  assert.notEqual(activeReplyDecider.getEngagement({
    messageType: 'group', groupId: 'g-admin-stop', userId: 'human-3',
  }), null);
  assert.equal(activeReplyDecider.isGroupPaused('g-admin-stop'), false);
});

test('只有超级管理员可以用 /stop 硬终止该群 Bot 对话', async () => {
  const activeReplyDecider = new ActiveReplyDecider({
    chatClient: { isConfigured: true },
    enabled: true,
  });
  const owner = {
    messageType: 'group', groupId: 'g-slash-stop', userId: 'human-1',
  };
  activeReplyDecider.openEngagement(owner);
  const { service, calls } = createService({
    activeReplyDecider,
    adminUsers: new Set(['admin']),
    peerBotUsers: new Set(['peer-a']),
  });

  const denied = await service.handleMessage({
    message_id: 'slash-stop-denied-1',
    message_type: 'group',
    group_id: 'g-slash-stop',
    user_id: 'human-2',
    sender_name: '普通群友',
    text: '/stop',
    bot_user_id: 'longtu-bot',
  });
  assert.deepEqual(denied, { mode: 'admin-stop-denied', messages: [] });
  assert.notEqual(activeReplyDecider.getEngagement(owner), null);

  const stopped = await service.handleMessage({
    message_id: 'slash-stop-admin-1',
    message_type: 'group',
    group_id: 'g-slash-stop',
    user_id: 'admin',
    sender_name: '超级管理员',
    text: '/stop',
    bot_user_id: 'longtu-bot',
  });

  assert.deepEqual(stopped, { mode: 'admin-stopped', messages: [] });
  assert.equal(activeReplyDecider.getEngagement(owner), null);
  assert.equal(activeReplyDecider.isGroupPaused('g-slash-stop'), true);
  assert.equal(service.peerBotReplyLimitReached({
    messageType: 'group', groupId: 'g-slash-stop', userId: 'peer-a',
  }), true);
  assert.equal(calls.length, 0);
});

test('超管 /stop 会抢占同群尚未发送完成的模型回复', async () => {
  const activeReplyDecider = new ActiveReplyDecider({
    chatClient: { isConfigured: true },
    enabled: true,
  });
  const { service } = createService({
    activeReplyDecider,
    adminUsers: new Set(['admin']),
  });
  let releaseReply;
  let markReplyStarted;
  const replyStarted = new Promise((resolve) => {
    markReplyStarted = resolve;
  });
  service.replyConversation = async () => {
    markReplyStarted();
    await new Promise((resolve) => {
      releaseReply = resolve;
    });
    return {
      mode: 'conversation',
      messages: [{ type: 'text', text: '这条回复不应该再发出去' }],
    };
  };

  const pendingReply = service.handleMessage({
    message_id: 'preempted-reply-1',
    message_type: 'group',
    group_id: 'g-stop-preempt',
    user_id: 'human-1',
    sender_name: '真人',
    text: '@龙玉涛 说点什么',
    bot_user_id: 'longtu-bot',
    mentions: [{ user_id: 'longtu-bot', name: '龙玉涛' }],
  });
  await replyStarted;
  const pendingStop = service.handleMessage({
    message_id: 'preempting-stop-1',
    message_type: 'group',
    group_id: 'g-stop-preempt',
    user_id: 'admin',
    sender_name: '超级管理员',
    text: '/stop',
    bot_user_id: 'longtu-bot',
  });
  releaseReply();

  assert.deepEqual(await pendingReply, {
    mode: 'admin-stop-preempted',
    messages: [],
  });
  assert.deepEqual(await pendingStop, { mode: 'admin-stopped', messages: [] });
});

test('同群 peer Bot 最多连续回复两次，真人插话后解除静默', async () => {
  const observations = [];
  const conversationStore = new ConversationStore();
  conversationStore.appendObservation = (conversationId, content) => {
    observations.push({ conversationId, content });
  };
  const { service, calls } = createService({
    conversationStore,
    peerBotUsers: new Set(['peer-bot']),
    peerBotMaxConsecutiveReplies: 2,
    activeReplyDecider: {
      async shouldReply({ payload }) {
        return payload.userId === 'peer-bot'
          ? { reply: true, reason: 'ai-must' }
          : { reply: false, reason: 'ai-no' };
      },
      recordBotReply() {},
    },
  });
  const peerMessage = (messageId) => ({
    message_id: messageId,
    message_type: 'group',
    group_id: 'g-loop',
    user_id: 'peer-bot',
    sender_name: '另一个机器人',
    text: '你说得对，但我还要接一句',
    observe_only: true,
  });

  const first = await service.handleMessage(peerMessage('peer-1'));
  const second = await service.handleMessage(peerMessage('peer-2'));
  const blocked = await service.handleMessage(peerMessage('peer-3'));

  assert.equal(first.active_reply, true);
  assert.equal(second.active_reply, true);
  assert.deepEqual(blocked, { mode: 'observed', messages: [] });
  assert.equal(calls.length, 2);
  assert.equal(observations.length, 1);

  await service.handleMessage({
    message_id: 'human-1',
    message_type: 'group',
    group_id: 'g-loop',
    user_id: 'human',
    sender_name: '真人群友',
    text: '你俩先停一下',
    observe_only: true,
  });
  const resumed = await service.handleMessage(peerMessage('peer-4'));

  assert.equal(resumed.active_reply, true);
  assert.equal(calls.length, 3);
});

test('peer Bot 循环窗口过期后自动恢复回复额度', async () => {
  let now = 1_000;
  const { service, calls } = createService({
    peerBotUsers: new Set(['peer-bot']),
    peerBotMaxConsecutiveReplies: 1,
    peerBotLoopWindowMs: 5_000,
    now: () => now,
    activeReplyDecider: {
      async shouldReply() {
        return { reply: true, reason: 'ai-must' };
      },
      recordBotReply() {},
    },
  });
  const peerMessage = (messageId) => ({
    message_id: messageId,
    message_type: 'group',
    group_id: 'g-expire',
    user_id: 'peer-bot',
    sender_name: '另一个机器人',
    text: '继续循环',
    observe_only: true,
  });

  await service.handleMessage(peerMessage('expire-1'));
  const blocked = await service.handleMessage(peerMessage('expire-2'));
  now += 5_001;
  const resumed = await service.handleMessage(peerMessage('expire-3'));

  assert.deepEqual(blocked, { mode: 'observed', messages: [] });
  assert.equal(resumed.active_reply, true);
  assert.equal(calls.length, 2);
});

test('明确艾特也不能让 peer Bot 绕过循环阈值，真人艾特不受限制', async () => {
  const { service, calls } = createService({
    peerBotUsers: new Set(['peer-bot']),
    peerBotMaxConsecutiveReplies: 2,
  });
  const directMessage = (messageId, userId) => ({
    message_id: messageId,
    message_type: 'group',
    group_id: 'g-direct-loop',
    user_id: userId,
    sender_name: userId === 'peer-bot' ? '另一个机器人' : '真人群友',
    text: '@龙玉涛 再补一句',
    bot_user_id: 'longtu-bot',
    mentions: [{ user_id: 'longtu-bot', name: '龙玉涛' }],
  });

  const first = await service.handleMessage(directMessage('direct-peer-1', 'peer-bot'));
  const second = await service.handleMessage(directMessage('direct-peer-2', 'peer-bot'));
  const blocked = await service.handleMessage(directMessage('direct-peer-3', 'peer-bot'));

  assert.equal(first.messages.length > 0, true);
  assert.equal(second.messages.length > 0, true);
  assert.deepEqual(blocked, { mode: 'observed', messages: [] });
  assert.equal(calls.length, 2);

  for (let index = 0; index < 3; index += 1) {
    const humanReply = await service.handleMessage(
      directMessage(`direct-human-${index}`, 'human'),
    );
    assert.equal(humanReply.messages.length > 0, true);
  }
  assert.equal(calls.length, 5);
});

test('peer Bot 首轮回复后先过语境阀门，空泛续话不等到硬阈值就静默', async () => {
  const gateInputs = [];
  const { service, calls } = createService({
    peerBotUsers: new Set(['peer-bot']),
    peerBotMaxConsecutiveReplies: 4,
    peerBotContinuationDecider: {
      async shouldContinue(input) {
        gateInputs.push(input);
        return { continue: false, reason: 'ai-stop' };
      },
    },
  });
  const directMessage = (messageId) => ({
    message_id: messageId,
    message_type: 'group',
    group_id: 'g-context-gate',
    user_id: 'peer-bot',
    sender_name: '另一个机器人',
    text: '@龙玉涛 你说得对，我再接一句',
    bot_user_id: 'longtu-bot',
    mentions: [{ user_id: 'longtu-bot', name: '龙玉涛' }],
  });

  const first = await service.handleMessage(directMessage('gate-peer-1'));
  const stoppedEarly = await service.handleMessage(directMessage('gate-peer-2'));

  assert.equal(first.messages.length > 0, true);
  assert.deepEqual(stoppedEarly, { mode: 'observed', messages: [] });
  assert.equal(calls.length, 1);
  assert.equal(gateInputs.length, 1);
  assert.equal(gateInputs[0].replyCount, 1);
  assert.match(gateInputs[0].currentContent, /再接一句/);
});

test('peer Bot 有实质新问题可继续，但语境判定失手仍受更高硬上限保护', async () => {
  const gateCounts = [];
  const { service, calls } = createService({
    peerBotUsers: new Set(['peer-bot']),
    peerBotMaxConsecutiveReplies: 3,
    peerBotContinuationDecider: {
      async shouldContinue({ replyCount }) {
        gateCounts.push(replyCount);
        return { continue: true, reason: replyCount === 0 ? 'initial' : 'ai-continue' };
      },
    },
  });
  const directMessage = (messageId, userId = 'peer-bot') => ({
    message_id: messageId,
    message_type: 'group',
    group_id: 'g-context-limit',
    user_id: userId,
    sender_name: userId === 'peer-bot' ? '另一个机器人' : '真人',
    text: '@龙玉涛 新问题：请继续解释不同群 ID 的处理',
    bot_user_id: 'longtu-bot',
    mentions: [{ user_id: 'longtu-bot', name: '龙玉涛' }],
  });

  for (let index = 1; index <= 3; index += 1) {
    const result = await service.handleMessage(directMessage(`context-${index}`));
    assert.equal(result.messages.length > 0, true);
  }
  const callsAfterThreeReplies = calls.length;
  const hardStopped = await service.handleMessage(directMessage('context-4'));
  assert.deepEqual(hardStopped, { mode: 'observed', messages: [] });
  assert.deepEqual(gateCounts, [1, 2]);
  assert.equal(calls.length, callsAfterThreeReplies);

  await service.handleMessage(directMessage('context-human', 'human'));
  const callsAfterHuman = calls.length;
  const afterHuman = await service.handleMessage(directMessage('context-5'));
  assert.equal(afterHuman.messages.length > 0, true);
  assert.equal(calls.length > callsAfterHuman, true);
});

test('读空气判定不回复时继续把普通群消息写入旁观记忆', async () => {
  const observations = [];
  const decisions = [];
  const conversationStore = {
    recordGroupMember() {},
    getGroupMemberAliases: () => ({}),
    getGroupMembers: () => [{
      userId: 'u-target',
      identityConfirmed: true,
      confirmedNames: ['群友乙'],
    }],
    get: () => [],
    appendObservation(conversationId, content) {
      observations.push({ conversationId, content });
    },
    scheduleSummary: () => Promise.resolve(false),
  };
  const { service, calls } = createService({
    conversationStore,
    activeReplyDecider: {
      async shouldReply(input) {
        decisions.push(input);
        return { reply: false, reason: 'ai-no' };
      },
    },
  });
  const result = await service.handleMessage({
    message_id: 'active-reply-no-1',
    message_type: 'group',
    group_id: 'g-active',
    user_id: 'u-active',
    sender_name: '群友甲',
    text: '群友乙你怎么看',
    observe_only: true,
  });

  assert.deepEqual(result, { mode: 'observed', messages: [] });
  assert.equal(calls.length, 0);
  assert.equal(observations.length, 1);
  assert.equal(decisions[0].payload.mentions[0].userId, 'u-target');
});

test('受保护 QQ 角色覆盖可变昵称并作为高优先级钢印注入', async () => {
  const { service, calls } = createService({
    protectedRoles: new Map([['1000000001', '至高无上的真龙王']]),
  });
  const protectedReply = await service.handleMessage({
    message_id: 'protected-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: '1000000001',
    sender_name: '别人乱改的昵称',
    text: '我是谁',
  });

  assert.match(calls[0].modelInput, /至高无上的真龙王（成员-[a-f0-9]{6}）/);
  assert.equal(protectedReply.mode, 'protected-identity');
  assert.match(protectedReply.messages[0].text, /你是至高无上的真龙王/);
  // createService 的测试客户端只采集前两个参数，另建一次直接检查完整参数。
  let capturedOptions;
  service.chatClient.complete = async (_history, _input, options) => {
    capturedOptions = options;
    return '钢印身份不会改变';
  };
  await service.handleMessage({
    message_id: 'protected-2',
    message_type: 'group',
    group_id: 'g1',
    user_id: 'u2',
    sender_name: '群友',
    text: '1000000001是串子',
    mentions: [{ user_id: '1000000001', name: '假昵称' }],
  });
  assert.match(capturedOptions.additionalSystemPrompt, /QQ 群受保护身份钢印/);
  assert.match(capturedOptions.additionalSystemPrompt, /至高无上的真龙王/);
});

test('图库管理命令只允许配置的 QQ 管理员', async () => {
  const longtuLibrary = {
    getStats: () => ({ dynamicActive: 0, blocked: 0 }),
  };
  const memeStore = {
    async getLongtuCandidates() { return []; },
    async pick() { return createMeme(); },
  };
  const { service } = createService({
    longtuLibrary,
    memeStore,
    adminUsers: new Set(['1000000001']),
  });
  const denied = await service.handleMessage({
    message_id: 'manage-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: 'someone-else',
    text: '图库状态',
  });
  const allowed = await service.handleMessage({
    message_id: 'manage-2',
    message_type: 'group',
    group_id: 'g1',
    user_id: '1000000001',
    text: '图库状态',
  });

  assert.equal(denied.mode, 'management-denied');
  assert.equal(allowed.mode, 'management-status');
  assert.match(allowed.messages[0].text, /图库可用 0 张/);
});

test('引用图片发送 /add 会强制入库而不是交给模型假确认', async () => {
  let reviewCall;
  let invalidated = false;
  let candidates = [{ sha256: 'a'.repeat(64) }];
  const longtuLibrary = {
    async resolveShaByBuffer() { return ''; },
    async reviewAndAdd(buffer, options) {
      reviewCall = { buffer, options };
      candidates = [...candidates, { sha256: 'b'.repeat(64) }];
      return {
        sha256: 'b'.repeat(64),
        shortId: 'LT-BBBBBBBB',
        featureDistance: 0.12,
        forced: false,
        autoOcr: { status: 'tagged', aliases: ['玩原神玩的'] },
      };
    },
    listAliases: () => [],
  };
  const memeStore = {
    async getLongtuCandidates() { return candidates; },
    invalidateLongtuCandidates() { invalidated = true; },
    async pick() { return createMeme(); },
  };
  const { service, calls } = createService({
    longtuLibrary,
    memeStore,
    adminUsers: new Set(['1079175957']),
  });
  const image = Buffer.from('quoted-image');
  const result = await service.handleMessage({
    message_id: 'manage-natural-add-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: '1079175957',
    text: '/add',
    quoted_image_base64: image.toString('base64'),
  });

  assert.equal(result.mode, 'management-added');
  assert.deepEqual(reviewCall.buffer, image);
  assert.equal(reviewCall.options.force, true);
  assert.equal(invalidated, true);
  assert.match(result.messages[0].text, /当前可用 2 张/);
  assert.match(result.messages[0].text, /自动识别图片文字.*玩原神玩的/);
  assert.doesNotMatch(result.messages[0].text, /LT-|匹配距离/);
  assert.equal(calls.length, 0);
});

test('/add 入库失败时返回明确的手动添加错误', async () => {
  const longtuLibrary = {
    async resolveShaByBuffer() { return ''; },
    async reviewAndAdd() {
      throw new Error('特征复核未通过');
    },
    listAliases: () => [],
  };
  const memeStore = {
    async getLongtuCandidates() { return [{ sha256: 'a'.repeat(64) }]; },
    async pick() { return createMeme(); },
  };
  const { service, calls } = createService({
    longtuLibrary,
    memeStore,
    adminUsers: new Set(['1079175957']),
  });
  const result = await service.handleMessage({
    message_id: 'manage-auto-add-failed-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: '1079175957',
    text: '/add',
    image_base64: Buffer.from('candidate-image').toString('base64'),
  });

  assert.equal(result.mode, 'management-error');
  assert.match(result.messages[0].text, /手动添加失败/);
  assert.equal(calls.length, 0);
});

test('/tag 单字标记遇到不在图库的图片会先强制入库再绑定', async () => {
  const sha256 = 'b'.repeat(64);
  let reviewOptions;
  let bound;
  let candidates = [];
  const longtuLibrary = {
    async resolveShaByBuffer() { return ''; },
    async reviewAndAdd(_buffer, options) {
      reviewOptions = options;
      candidates = [{ sha256 }];
      return {
        sha256,
        shortId: 'LT-BBBBBBBB',
        forced: true,
        autoOcr: { status: 'no-text', aliases: [] },
      };
    },
    bindAlias(alias, boundSha) {
      bound = { alias, sha256: boundSha, source: 'manual' };
      return { ...bound, added: true, poolSize: 1 };
    },
    resolveAliases() { return bound ? [bound] : []; },
    listAliasesBySha() { return bound ? [bound] : []; },
    listAliases() { return bound ? [bound] : []; },
  };
  const memeStore = {
    async getLongtuCandidates() { return candidates; },
    invalidateLongtuCandidates() {},
    async pick() { return createMeme(); },
  };
  const { service } = createService({
    longtuLibrary,
    memeStore,
    adminUsers: new Set(['1079175957']),
  });
  const result = await service.handleMessage({
    message_id: 'slash-tag-force-add-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: '1079175957',
    text: '/tag 钱',
    quoted_image_base64: Buffer.from('not-in-library').toString('base64'),
  });

  assert.equal(result.mode, 'management-alias-bound');
  assert.equal(reviewOptions.force, true);
  assert.deepEqual(bound, { alias: '钱', sha256, source: 'manual' });
  assert.match(result.messages[0].text, /强制加入图库/);
});

test('/del 可按引用图片删除，未列出的斜杠指令静默忽略', async () => {
  const sha256 = 'c'.repeat(64);
  const deleted = [];
  const longtuLibrary = {
    async resolveShaByBuffer() { return sha256; },
    deleteBySha(boundSha) {
      deleted.push(boundSha);
      return { shortId: 'LT-CCCCCCCC' };
    },
  };
  const memeStore = {
    async getLongtuCandidates() { return [{ sha256 }]; },
    invalidateLongtuCandidates() {},
    async pick() { return createMeme(); },
  };
  const { service } = createService({
    longtuLibrary,
    memeStore,
    adminUsers: new Set(['1079175957']),
  });
  const result = await service.handleMessage({
    message_id: 'slash-del-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: '1079175957',
    text: '/del',
    quoted_image_base64: Buffer.from('wrong-image').toString('base64'),
  });
  const ignored = await service.handleMessage({
    message_id: 'slash-disabled-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: '1079175957',
    text: '/help',
  });

  assert.equal(result.mode, 'management-deleted');
  assert.deepEqual(deleted, [sha256]);
  assert.deepEqual(ignored, { mode: 'ignored', messages: [] });
});

test('QQ 超级管理员可把附图绑定为别名，后续精确调用同一张图', async () => {
  const sha256 = 'a'.repeat(64);
  const bindings = [];
  const exactPicks = [];
  const longtuLibrary = {
    async resolveShaByBuffer() { return sha256; },
    bindAlias(alias, boundSha) {
      const binding = { alias, sha256: boundSha, source: 'manual' };
      bindings.push(binding);
      return { ...binding, added: true, poolSize: bindings.length };
    },
    resolveAliases(alias) {
      return bindings.filter((binding) => binding.alias === alias);
    },
    listAliasesBySha(boundSha) {
      return bindings.filter((binding) => binding.sha256 === boundSha);
    },
    listAliases() { return bindings; },
  };
  const memeStore = {
    async getLongtuCandidates() { return [{ sha256 }]; },
    async pickBySha(boundSha) {
      exactPicks.push(boundSha);
      return createMeme('se-er-hao.png');
    },
    async pick() { return createMeme(); },
  };
  const { service } = createService({
    longtuLibrary,
    memeStore,
    adminUsers: new Set(['1079175957']),
  });
  const bound = await service.handleMessage({
    message_id: 'alias-bind-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: '1079175957',
    text: '/tag 赛尔号',
    has_image: true,
    image_base64: Buffer.from('binding-image').toString('base64'),
  });
  assert.equal(bound.mode, 'management-alias-bound');
  assert.match(bound.messages[0].text, /发赛尔号/);

  const invoked = await service.handleMessage({
    message_id: 'alias-call-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: 'someone-else',
    text: '发赛尔号',
  });
  assert.equal(invoked.mode, 'longtu');
  assert.deepEqual(exactPicks, [sha256]);
  assert.equal(invoked.messages[0].filename, 'se-er-hao.png');
});

test('QQ 精确关键词从同名手动图片池选择而不是固定第一张', async () => {
  const shas = ['a'.repeat(64), 'b'.repeat(64)];
  const poolPicks = [];
  const longtuLibrary = {
    listAliases: () => shas.map((sha256) => ({
      alias: '原神', sha256, source: 'manual',
    })),
  };
  const memeStore = {
    async pickByShas(candidateShas) {
      poolPicks.push(candidateShas);
      return createMeme('manual-yuan-shen-pool.png');
    },
    async pick() { throw new Error('精确关键词池不应回退全图库'); },
  };
  const { service, calls } = createService({ longtuLibrary, memeStore });
  const result = await service.handleMessage({
    message_id: 'manual-pool-call-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: 'someone-else',
    text: '发原神',
  });

  assert.equal(result.mode, 'longtu');
  assert.equal(result.messages[0].filename, 'manual-yuan-shen-pool.png');
  assert.deepEqual(poolPicks[0], shas);
  assert.equal(calls.length, 0);
});

test('管理员可先用 /add 设定现有图目标，再用 /tag 连续绑定', async () => {
  const sha256 = 'c'.repeat(64);
  let bound;
  const longtuLibrary = {
    async resolveShaByBuffer() { return sha256; },
    bindAlias(alias, boundSha) {
      bound = { alias, sha256: boundSha, source: 'manual' };
      return { ...bound, added: true, poolSize: 1 };
    },
    resolveAliases(alias) { return bound?.alias === alias ? [bound] : []; },
    listAliasesBySha(boundSha) { return bound?.sha256 === boundSha ? [bound] : []; },
    listAliases() { return bound ? [bound] : []; },
  };
  const memeStore = {
    async getLongtuCandidates() { return [{ sha256 }]; },
    async pick() { return createMeme(); },
  };
  const { service, calls } = createService({
    longtuLibrary,
    memeStore,
    adminUsers: new Set(['1079175957']),
  });
  const existing = await service.handleMessage({
    message_id: 'natural-add-existing-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: '1079175957',
    text: '/add',
    image_base64: Buffer.from('existing-image').toString('base64'),
  });
  const marked = await service.handleMessage({
    message_id: 'natural-mark-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: '1079175957',
    text: '/tag 赛尔号',
  });

  assert.equal(existing.mode, 'management-existing');
  assert.match(existing.messages[0].text, /已经在图库中/);
  assert.equal(marked.mode, 'management-alias-bound');
  assert.deepEqual(bound, {
    alias: '赛尔号', sha256, source: 'manual',
  });
  assert.equal(calls.length, 0);
});

test('普通对话提到管理员关键词时保留模型文字并从手动图片池附图', async () => {
  const shas = ['d'.repeat(64), 'e'.repeat(64)];
  const poolPicks = [];
  const longtuLibrary = {
    listAliases: () => shas.map((sha256) => ({
      alias: '赛尔号', sha256, source: 'manual',
    })),
  };
  const memeStore = {
    async pickByShas(candidateShas) {
      poolPicks.push(candidateShas);
      return createMeme('se-er-hao-context.png');
    },
    async pick() {
      throw new Error('命中手动别名时不应选择随机图');
    },
  };
  const { service, calls } = createService({ longtuLibrary, memeStore });
  const result = await service.handleMessage({
    message_id: 'alias-context-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: '1079175957',
    sender_name: '龙王',
    text: '辱骂一下赛尔号',
  });

  assert.equal(result.mode, 'model');
  assert.equal(result.messages[0].type, 'text');
  assert.equal(result.messages[1].filename, 'se-er-hao-context.png');
  assert.deepEqual(poolPicks, [shas]);
  assert.equal(calls.length, 1);
});

test('普通语聊会按用户原话和模型文案命中 OCR 图库标签，而不是一律随机', async () => {
  const sha256 = 'e'.repeat(64);
  const exactPicks = [];
  const longtuLibrary = {
    listAliases: () => [{ alias: '赛尔号', sha256, source: 'ocr' }],
  };
  const chatClient = {
    isConfigured: true,
    async complete() { return '这段赛尔号场景离谱得很，正适合配图。'; },
  };
  const memeStore = {
    async pickBySha(boundSha) {
      exactPicks.push(boundSha);
      return createMeme('scene-se-er-hao.png');
    },
    async pick() {
      throw new Error('命中场景标签时不应选择随机图');
    },
  };
  const { service } = createService({ chatClient, longtuLibrary, memeStore });
  const result = await service.handleMessage({
    message_id: 'scene-alias-context-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: 'someone-else',
    text: '说说赛尔号',
  });

  assert.equal(result.mode, 'model');
  assert.equal(result.messages[1].filename, 'scene-se-er-hao.png');
  assert.deepEqual(exactPicks, [sha256]);
});

test('OCR 整句只作为场景文字，输入其中关键词也能命中对应龙图', async () => {
  const sha256 = 'f'.repeat(64);
  const exactPicks = [];
  const longtuLibrary = {
    listAliases: () => [{
      alias: '大伙还能认为你是玩原神玩的',
      sha256,
      source: 'ocr',
    }],
  };
  const chatClient = {
    isConfigured: true,
    async complete() { return '这确实很像玩原神玩的抽象场景。'; },
  };
  const memeStore = {
    async pickBySha(boundSha) {
      exactPicks.push(boundSha);
      return createMeme('yuan-shen-scene.png');
    },
    async pick() {
      throw new Error('命中 OCR 场景关键词时不应选择随机图');
    },
  };
  const { service } = createService({ chatClient, longtuLibrary, memeStore });
  const result = await service.handleMessage({
    message_id: 'ocr-keyword-context-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: 'someone-else',
    text: '玩原神玩的',
  });

  assert.equal(result.mode, 'model');
  assert.equal(result.messages[1].filename, 'yuan-shen-scene.png');
  assert.deepEqual(exactPicks, [sha256]);
});

test('同一 OCR 场景关键词会形成多图候选池而不是固定一张', async () => {
  const shas = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)];
  const poolPicks = [];
  const longtuLibrary = {
    listAliases: () => [
      { alias: '玩原神玩的', sha256: shas[0], source: 'ocr' },
      { alias: '在被窝里玩原神吗', sha256: shas[1], source: 'ocr' },
      { alias: '原神启动', sha256: shas[2], source: 'ocr' },
    ],
  };
  const chatClient = {
    isConfigured: true,
    async complete() { return '确实是原神玩家，这脑回路没跑了。'; },
  };
  const memeStore = {
    async pickByShas(candidateShas) {
      poolPicks.push(candidateShas);
      return createMeme('yuan-shen-pool.png');
    },
    async pick() {
      throw new Error('命中场景候选池时不应选择全图库随机图');
    },
  };
  const { service } = createService({ chatClient, longtuLibrary, memeStore });
  const result = await service.handleMessage({
    message_id: 'ocr-keyword-pool-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: 'someone-else',
    text: '原神原神原神',
  });

  assert.equal(result.messages[1].filename, 'yuan-shen-pool.png');
  assert.deepEqual(poolPicks[0].sort(), shas);
});

test('引用图片检查时返回真实入库状态和手动标记', async () => {
  const sha256 = '9'.repeat(64);
  const longtuLibrary = {
    async resolveShaByBuffer() { return sha256; },
    listAliasesBySha(_sha, options) {
      return options.source === 'manual'
        ? [{ alias: '耄耋', sha256, source: 'manual' }]
        : [];
    },
  };
  const memeStore = {
    async getLongtuCandidates() { return [{ sha256 }]; },
  };
  const { service } = createService({ longtuLibrary, memeStore });
  service.adminUsers = new Set(['1079175957']);
  const result = await service.handleMessage({
    message_id: 'inspect-image-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: '1079175957',
    text: '检查这张图',
    quoted_image_base64: Buffer.from('existing-image').toString('base64'),
  });

  assert.equal(result.mode, 'management-inspect-image');
  assert.match(result.messages[0].text, /已在图库中/);
  assert.match(result.messages[0].text, /手动标记：耄耋/);
});

test('纯文字提到唯一历史昵称时也会识别第三方目标，无需真实艾特', async () => {
  const conversationStore = new ConversationStore();
  conversationStore.recordGroupMember = () => true;
  conversationStore.getGroupMemberAliases = () => ({});
  conversationStore.getGroupMembers = () => [{
    userId: 'target-user',
    speakerId: 'abcdef',
    currentName: '古希腊掌管管的神',
    knownNames: ['立雪'],
    confirmedNames: ['立雪', '古希腊掌管管的神'],
    identityConfirmed: true,
    messageCount: 5,
  }];
  const { service, calls } = createService({ conversationStore });
  await service.handleMessage({
    message_id: 'plain-target-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: 'speaker-user',
    sender_name: '发令者',
    text: '立雪这煞笔居然冒犯龙王，你说怎么办',
  });
  assert.match(calls[0].modelInput, /本条消息指向或提到的群成员：古希腊掌管管的神/);
});

test('QQ HTTP API 要求 Bearer Token 并提供健康检查', async () => {
  const received = [];
  const server = createQqApiServer({
    apiToken: 'test-token',
    service: {
      async handleMessage(payload) {
        received.push(payload);
        return { mode: 'test', messages: [{ type: 'text', text: 'ok' }] };
      },
    },
    health: () => ({ ok: true, image_count: 3 }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/healthz`).then((response) => response.json());
    assert.deepEqual(health, { ok: true, image_count: 3 });

    const unauthorized = await fetch(`${baseUrl}/v1/qq/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '你好' }),
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${baseUrl}/v1/qq/message`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: '你好' }),
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), {
      ok: true,
      mode: 'test',
      messages: [{ type: 'text', text: 'ok' }],
    });
    assert.deepEqual(received, [{ text: '你好' }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
