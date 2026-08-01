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
    conversationStore: new ConversationStore(),
    webSearchEnabled: false,
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
