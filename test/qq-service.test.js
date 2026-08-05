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
