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

test('current-date references are updated without rewriting the story or its historical dates', async () => {
  const cases = [
    ['今天是 7 月 11 日', '今天是 10 月 8 日'],
    ['今天7月11号', '今天10月8号'],
    ['今日是2024年7月11日', '今日是2026年10月8日'],
    ['今天是七月十一日', '今天是10月8日'],
    ['现在是 4 月 7 日', '现在是 10 月 8 日'],
    ['今天是 2024-07-11', '今天是 2026-10-08'],
    ['今日：07/11', '今日：10/08'],
    ['今天是7.11', '今天是10.8'],
    ['今天是9.9元，今日8.8折', '今天是9.9元，今日8.8折'],
  ];
  for (const [before, after] of cases) {
    const ending = '，我们和平分手。去年7月11日的事还记得，已经过去1年4天21小时。今天疯狂星期四，v我50。';
    const { service, calls } = createService({
      crazyThursdayStyleSourceUrl: 'https://example.test/v50.json',
      crazyThursdayFetch: async () => ({ ok: true, text: async () => JSON.stringify([before + ending]) }),
    });
    const result = await service.handleMessage({
      message_type: 'private', user_id: 'admin', crazy_thursday_request: true,
      crazy_thursday_test: true, crazy_thursday_date: '2026-10-08',
    });
    assert.equal(result.messages[0].text, after + ending, before);
    assert.equal(calls.length, 0);
  }
});

test('cached public originals adapt to each scheduled date, including across years', async () => {
  const original = '今天是2024年7月11日，还是分手了，谢谢大家。今天疯狂星期四，v我50。';
  let fetchCount = 0;
  const { service } = createService({
    crazyThursdayStyleSourceUrl: 'https://example.test/v50.json',
    crazyThursdayFetch: async () => {
      fetchCount += 1;
      return { ok: true, text: async () => JSON.stringify([original]) };
    },
  });
  for (const [date, displayedDate] of [['2026-12-31', '2026年12月31日'], ['2027-01-07', '2027年1月7日']]) {
    const result = await service.handleMessage({
      message_type: 'group', group_id: '123', user_id: 'system-crazy-thursday',
      crazy_thursday_request: true, crazy_thursday_scheduled: true, crazy_thursday_date: date,
    });
    assert.equal(result.messages[0].text, original.replace('2024年7月11日', displayedDate));
  }
  assert.equal(fetchCount, 1);
  assert.deepEqual(service.crazyThursdayStyleCache.entries, [original]);
});

test('missing push date uses the current Shanghai day instead of the UTC day', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-07T16:30:00Z') });
  const { service } = createService({
    crazyThursdayStyleSourceUrl: 'https://example.test/v50.json',
    crazyThursdayFetch: async () => ({
      ok: true,
      text: async () => JSON.stringify(['今天是7月11日，还是分手了，谢谢大家。今天疯狂星期四，v我50。']),
    }),
  });
  const result = await service.handleMessage({
    message_type: 'private', user_id: 'admin', crazy_thursday_request: true, crazy_thursday_test: true,
  });
  assert.equal(result.messages[0].text, '今天是10月8日，还是分手了，谢谢大家。今天疯狂星期四，v我50。');
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

test('cached entries are calendar-filtered for both scheduled and private requests on each date', async () => {
  const seasonal = '今天是今年最后一次KFC疯狂星期四，把握住最后一个星期四，也把握住我。';
  const ordinary = '医生说我需要补充能量，处方是炸鸡一份。今天疯狂星期四，v我50。';
  const entries = [seasonal, ordinary];
  let fetchCount = 0;
  const { service, calls } = createService({
    crazyThursdayStyleSourceUrl: 'https://example.test/v50.json',
    crazyThursdayFetch: async () => {
      fetchCount += 1;
      return { ok: true, text: async () => JSON.stringify(entries) };
    },
  });
  const request = (date, scheduled) => service.handleMessage({
    message_type: scheduled ? 'group' : 'private', group_id: scheduled ? '123' : '',
    user_id: scheduled ? 'system-crazy-thursday' : 'admin',
    crazy_thursday_request: true, crazy_thursday_scheduled: scheduled,
    crazy_thursday_test: !scheduled, crazy_thursday_date: date,
  });
  for (const scheduled of [true, false]) {
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await request('2026-10-08', scheduled)).messages[0].text, ordinary);
    }
  }
  const yearEnd = [await request('2026-12-31', true), await request('2026-12-31', true)];
  assert.deepEqual(new Set(yearEnd.map((result) => result.messages[0].text)), new Set(entries));
  assert.equal(fetchCount, 1);
  assert.deepEqual(service.crazyThursdayStyleCache.entries, entries);
  assert.equal(calls.length, 0);
});

test('an all-expired online pool falls back to eligible local originals without LLM calls', async () => {
  const expired = '今天是2024年最后一次KFC疯狂星期四，前51个你们都没请我吃，也把握住我。';
  const { service, calls } = createService({
    crazyThursdayStyleSourceUrl: 'https://example.test/v50.json',
    crazyThursdayFetch: async () => ({ ok: true, text: async () => JSON.stringify([expired]) }),
  });
  for (let i = 0; i < 12; i += 1) {
    const result = await service.handleMessage({
      message_type: 'private', user_id: 'admin', crazy_thursday_request: true,
      crazy_thursday_test: true, crazy_thursday_date: '2026-07-09',
    });
    assert.equal(result.mode, 'crazy-thursday');
    assert.ok(result.messages[0].text);
    assert.notEqual(result.messages[0].text, expired);
    assert.doesNotMatch(result.messages[0].text, /冬天/u);
  }
  assert.equal(calls.length, 0);
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
