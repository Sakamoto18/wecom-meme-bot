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
      return '这是 QQ 回答';
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
  });
  const message = buildQqCompatibleMessage(payload);

  assert.equal(payload.text, '你好');
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
  assert.equal(first.messages[0].text, '这是 QQ 回答');
  assert.match(calls[0].modelInput, /发言人：QQ 小明/);
  assert.equal(calls[1].history.length, 2);
  assert.match(calls[1].history[0].content, /当前消息：你好/);
  assert.equal(second.messages[0].text, '这是 QQ 回答');
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
      return options?.systemPrompt ? '更新后的长期摘要' : '我记得你喜欢蓝色。';
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

test('受保护 QQ 角色覆盖可变昵称并作为高优先级钢印注入', async () => {
  const { service, calls } = createService({
    protectedRoles: new Map([['1000000001', '至高无上的真龙王']]),
  });
  await service.handleMessage({
    message_id: 'protected-1',
    message_type: 'group',
    group_id: 'g1',
    user_id: '1000000001',
    sender_name: '别人乱改的昵称',
    text: '我是谁',
  });

  assert.match(calls[0].modelInput, /至高无上的真龙王（成员-[a-f0-9]{6}）/);
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
