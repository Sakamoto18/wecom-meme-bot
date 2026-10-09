import test from 'node:test';
import assert from 'node:assert/strict';
import { QqBotService, normalizeQqPayload } from '../src/qq-service.js';

function createService(options = {}) {
  const calls = [];
  const service = new QqBotService({
    chatClient: {
      isConfigured: options.chatConfigured ?? false,
      async complete(history, input, requestOptions) {
        calls.push({ history, input, options: requestOptions });
        return '不应该调用模型';
      },
    },
    adminUsers: new Set(['admin']),
    ...options,
  });
  return { service, calls };
}

test('crazy Thursday request sends an exact public-library entry without LLM rewriting', async () => {
  const original = '抑郁了，医生给我开了一张处方：炸鸡、薯条汉堡、可乐 500ml；今天疯狂星期四，v 我 50。';
  const { service, calls } = createService({
    crazyThursdayStyleSourceUrl: 'https://example.test/v50.json',
    crazyThursdayFetch: async () => ({
      ok: true,
      async text() { return JSON.stringify([original]); },
    }),
  });
  const result = await service.handleMessage({
    message_id: 'crazy-1', message_type: 'private', user_id: 'admin',
    text: '', crazy_thursday_request: true, crazy_thursday_test: true,
    crazy_thursday_date: '2026-10-08', crazy_thursday_holiday_context: '国庆节刚过7天',
  });
  assert.equal(result.mode, 'crazy-thursday');
  assert.equal(result.messages[0].text, original);
  assert.equal(calls.length, 0);
});

test('crazy Thursday manual test is admin-only while scheduled push is trusted', async () => {
  const { service, calls } = createService();
  const denied = await service.handleMessage({
    message_id: 'crazy-2', message_type: 'private', user_id: 'member',
    text: '', crazy_thursday_request: true, crazy_thursday_test: true,
  });
  assert.equal(denied.mode, 'crazy-thursday-denied');
  assert.equal(calls.length, 0);

  const scheduled = await service.handleMessage({
    message_id: 'crazy-3', message_type: 'group', group_id: '123',
    user_id: 'system-crazy-thursday', text: '', crazy_thursday_request: true,
    crazy_thursday_scheduled: true,
  });
  assert.equal(scheduled.mode, 'crazy-thursday');
  assert.equal(calls.length, 0);
});

test('manual crazy Thursday test is silent in group chats', async () => {
  const { service, calls } = createService();
  const result = await service.handleMessage({
    message_id: 'crazy-4', message_type: 'group', group_id: '123',
    user_id: 'admin', text: '', crazy_thursday_request: true,
    crazy_thursday_test: true,
  });
  assert.equal(result.mode, 'crazy-thursday-ignored');
  assert.deepEqual(result.messages, []);
  assert.equal(calls.length, 0);
});

test('same date avoids repeating an exact quote until the public pool is exhausted', async () => {
  const entries = [
    '医生说我需要补充能量，处方是炸鸡一份。今天疯狂星期四，v 我 50。',
    '天气预报说明天有雨，出门记得带伞。今天疯狂星期四，v 我 50。',
  ];
  const { service } = createService({
    crazyThursdayStyleSourceUrl: 'https://example.test/v50.json',
    crazyThursdayFetch: async () => ({
      ok: true,
      async text() { return JSON.stringify(entries); },
    }),
  });
  const request = (id) => service.handleMessage({
    message_id: id, message_type: 'group', group_id: '123',
    user_id: 'system-crazy-thursday', text: '', crazy_thursday_request: true,
    crazy_thursday_scheduled: true, crazy_thursday_date: '2026-10-08',
  });
  const first = await request('crazy-5');
  const second = await request('crazy-6');
  assert.notEqual(first.messages[0].text, second.messages[0].text);
});

test('unsafe public entries are filtered before direct delivery', async () => {
  const { service } = createService({
    crazyThursdayStyleSourceUrl: 'https://example.test/v50.json',
    crazyThursdayFetch: async () => ({
      ok: true,
      async text() {
        return JSON.stringify([
          '我今天要跳楼，疯狂星期四 v 我 50。',
          '医生开了处方：炸鸡、薯条和可乐。今天疯狂星期四，v 我 50。',
        ]);
      },
    }),
  });
  const result = await service.handleMessage({
    message_id: 'crazy-7', message_type: 'private', user_id: 'admin',
    text: '', crazy_thursday_request: true, crazy_thursday_test: true,
  });
  assert.equal(result.messages[0].text, '医生开了处方：炸鸡、薯条和可乐。今天疯狂星期四，v 我 50。');
});

test('online public copy is parsed as complete entries', async () => {
  const service = new QqBotService({
    crazyThursdayStyleSourceUrl: 'https://example.test/crazy.md',
    crazyThursdayFetch: async () => ({
      ok: true,
      async text() {
        return '<p>人事部通知：暴雨预警，请参加肯德基疯狂星期四的同事带好雨具，v我50。</p>'
          + '<p>这是一段与主题无关的普通说明，不应该进入参考。</p>';
      },
    }),
    logger: { debug() {} },
  });
  const entries = await service.loadCrazyThursdayStyleEntries();
  assert.deepEqual(entries, ['人事部通知：暴雨预警，请参加肯德基疯狂星期四的同事带好雨具，v我50。']);
});

test('normal payloads preserve crazy Thursday fields only when explicitly set', () => {
  const payload = normalizeQqPayload({ message_type: 'group', group_id: '1', user_id: 'u', text: 'hi' });
  assert.equal(payload.crazyThursdayRequest, false);
});
