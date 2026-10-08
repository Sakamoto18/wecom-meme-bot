import test from 'node:test';
import assert from 'node:assert/strict';
import { QqBotService, normalizeQqPayload } from '../src/qq-service.js';

function createService(answer = '楼下打印店把我的身份证复印了三份，说其中一份要参加周四面试。') {
  const calls = [];
  const service = new QqBotService({
    chatClient: {
      isConfigured: true,
      async complete(history, input, options) {
        calls.push({ history, input, options });
        return answer;
      },
    },
    adminUsers: new Set(['admin']),
  });
  return { service, calls };
}

test('crazy Thursday request uses the tracked chat client and cleans output', async () => {
  const { service, calls } = createService('```\n文案：疯狂星期四，今天的快乐由我暂存，周末再统一发放。\n```');
  const result = await service.handleMessage({
    message_id: 'crazy-1', message_type: 'private', user_id: 'admin',
    text: '', crazy_thursday_request: true, crazy_thursday_test: true,
    crazy_thursday_date: '2026-10-08', crazy_thursday_holiday_context: '国庆节刚过7天',
  });
  assert.equal(result.mode, 'crazy-thursday');
  assert.equal(result.messages[0].text, '疯狂星期四，今天的快乐由我暂存，周末再统一发放。');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.usageSource, 'crazy-thursday');
  assert.deepEqual(calls[0].options.thinking, { type: 'disabled' });
  assert.match(calls[0].input, /不要机械复述节日和调休/u);
  assert.match(calls[0].input, /大多数时候完全不要提/u);
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
  assert.equal(calls.length, 1);
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

test('cliche crazy Thursday copy gets one focused revision', async () => {
  const calls = [];
  const service = new QqBotService({
    chatClient: {
      isConfigured: true,
      async complete(history, input, options) {
        calls.push({ history, input, options });
        return calls.length === 1
          ? '宇宙通知：今天 v 我 50，下午三点统一发放。'
          : '错误 503：快乐服务暂时不可用，排查结果是周四下午缺少一份鸡块。';
      },
    },
    adminUsers: new Set(['admin']),
  });
  const result = await service.handleMessage({
    message_id: 'crazy-5', message_type: 'private', user_id: 'admin',
    text: '', crazy_thursday_request: true, crazy_thursday_test: true,
  });
  assert.equal(result.mode, 'crazy-thursday');
  assert.equal(calls.length, 2);
  assert.match(calls[1].options.revisionSystemPrompt, /不是必选项/u);
  assert.match(result.messages[0].text, /错误 503/u);
});

test('normal payloads preserve crazy Thursday fields only when explicitly set', () => {
  const payload = normalizeQqPayload({ message_type: 'group', group_id: '1', user_id: 'u', text: 'hi' });
  assert.equal(payload.crazyThursdayRequest, false);
});
