import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleChatClient } from '../src/chat-client.js';

test('OpenAI 兼容客户端携带角色、历史与当前消息', async () => {
  let capturedUrl;
  let capturedOptions;
  const client = new OpenAICompatibleChatClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.example.com/',
    model: 'test-model',
    systemPrompt: '你是测试角色',
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '测试回复' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  const answer = await client.complete([
    { role: 'user', content: '上一问' },
    { role: 'assistant', content: '上一答' },
  ], '这一问', {
    additionalSystemPrompt: '本轮联网摘要',
    thinking: { type: 'disabled' },
  });
  const body = JSON.parse(capturedOptions.body);

  assert.equal(answer, '测试回复');
  assert.equal(capturedUrl, 'https://api.example.com/chat/completions');
  assert.equal(capturedOptions.headers.Authorization, 'Bearer test-key');
  assert.equal(body.model, 'test-model');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(body.messages.map((message) => message.role), [
    'system', 'system', 'user', 'assistant', 'user',
  ]);
  assert.equal(body.messages[1].content, '本轮联网摘要');
  assert.equal(body.messages.at(-1).content, '这一问');
});

test('OpenAI 兼容客户端将上游错误转成可诊断信息', async () => {
  const client = new OpenAICompatibleChatClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.example.com',
    model: 'test-model',
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: '余额不足' },
    }), { status: 402, headers: { 'Content-Type': 'application/json' } }),
  });

  await assert.rejects(
    client.complete([], '你好'),
    /HTTP 402.*余额不足/,
  );
});

test('OpenAI 兼容客户端允许单次请求覆盖超时时间', async () => {
  const client = new OpenAICompatibleChatClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.example.com',
    model: 'test-model',
    timeoutMs: 5,
    fetchImpl: async (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });

  await assert.rejects(
    client.complete([], '复杂问题', { timeoutMs: 10 }),
    /请求超时（10ms）/,
  );
});
