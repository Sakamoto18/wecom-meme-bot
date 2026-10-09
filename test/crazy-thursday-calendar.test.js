import test from 'node:test';
import assert from 'node:assert/strict';
import { crazyThursdayCalendarRejection as rejection } from '../src/crazy-thursday-calendar.js';

const last2024 = '今天是 2024 年最后一次 KFC 疯狂星期四，前 51 个你们都没请我吃，希望你们不要留下遗憾，把握住最后一个星期四，也把握住我';
const first2025 = '今天是 2025 年第一次 KFC 疯狂星期四，去年你们都没请我吃，希望你们不要留下遗憾，把握住今年第一个星期四，也把握住我';

test('the screenshot quote needs its original year AND the final Thursday of that year', () => {
  assert.equal(rejection(last2024, '2026-10-09'), 'wrong-year');
  assert.equal(rejection(last2024, '2026-12-31'), 'wrong-year');
  assert.equal(rejection(last2024, '2024-10-10'), 'wrong-thursday-ordinal');
  assert.equal(rejection(last2024, '2024-12-27'), 'not-thursday');
  assert.equal(rejection(last2024, '2024-12-26'), '');
});

test('first Thursday accepts its actual boundary, including Jan 1 and leap years', () => {
  assert.equal(rejection(first2025, '2025-01-02'), '');
  assert.equal(rejection(first2025, '2025-01-09'), 'wrong-thursday-ordinal');
  assert.equal(rejection(first2025, '2026-01-01'), 'wrong-year');
  assert.equal(rejection('今天是今年第一次疯狂星期四，V我50。', '2026-01-01'), '');
  assert.equal(rejection('今天是今年第一次疯狂星期四，V我50。', '2024-01-04'), '');
  assert.equal(rejection('作为 2k23 の 第一个疯狂星期四，vivo50', '2026-01-01'), 'wrong-year');
  assert.equal(rejection('今天是二〇二四年最后一个疯狂星期四，v我50。', '2024-12-26'), '');
});

test('annual and monthly ordinals and prior Thursday counts are not blindly rewritten', () => {
  const yearEnd = '今天是今年最后一个疯狂星期四，前51个你们都没请我吃，V我50。';
  assert.equal(rejection(yearEnd, '2026-12-31'), 'wrong-thursday-count');
  assert.equal(rejection(yearEnd.replace('51', '52'), '2026-12-31'), '');
  assert.equal(rejection('今年第44次疯狂期星四，V我50。', '2024-10-31'), '');
  assert.equal(rejection('今年第44次疯狂期星四，V我50。', '2024-10-24'), 'wrong-thursday-ordinal');
  assert.equal(rejection('今天是本月最后一个疯狂星期四，V我50。', '2026-10-29'), '');
  assert.equal(rejection('今天是本月最后一个疯狂星期四，V我50。', '2026-10-22'), 'wrong-thursday-ordinal');
  assert.equal(rejection('今天是最后一个疯狂星期四，V我50。', '2026-10-08'), 'unknown-calendar-period');
});

test('month-end and day-of-year claims must hold even when the date itself is adaptable', () => {
  const quote = '今天是10月31号，是我这个月0收入的最后一天，也是我今年0收入的第305天。疯狂星期四，v我50。';
  assert.equal(rejection(quote, '2026-10-08'), 'not-month-end');
  assert.equal(rejection(quote, '2026-10-31'), 'wrong-day-of-year');
  assert.equal(rejection(quote, '2024-10-31'), '');
});

test('festival assertions are date-gated and unverifiable holiday windows are skipped', () => {
  const children = '今天是六一儿童节，v我50吃肯德基疯狂星期四。';
  assert.equal(rejection(children, '2026-10-08'), 'wrong-holiday');
  assert.equal(rejection(children, '2026-06-01'), '');
  assert.equal(rejection('今天是6月1日，是儿童节，疯狂星期四v我50。', '2026-10-08'), 'wrong-holiday');
  assert.equal(rejection('明天是元旦，今天疯狂星期四，v我50。', '2026-12-31'), '');
  assert.equal(rejection('今天是春节，疯狂星期四v我50。', '2026-10-08'), 'unverified-holiday');
  assert.equal(rejection('过几天就要七夕了，今天疯狂星期四，v我50。', '2026-10-08'), 'unverified-holiday-window');
  assert.equal(rejection('国庆假期结束，我安排你调休，疯狂星期四，v我50。', '2026-03-05'), 'unverified-holiday-window');
});

test('fixed invitations, obsolete notices and exact current clock times stay out of daily rotation', () => {
  for (const text of [
    '本人谨定于农历腊月十七 (2025 年 1 月 16 日) 过星期四！随礼50。',
    '婚期：2023年8月27日（七月十二），新娘肯德基，v我50。',
    '全员核酸检测通知 明日（9月29日，周四），v我50。',
    '本人于2023年8月17日查出饥饿症，疯狂星期四，v我50。',
  ]) assert.equal(rejection(text, '2026-10-08'), 'dated-event');
  assert.equal(rejection('现在是下午三点四十六分，疯狂星期四，请我吃个肯德基？', '2026-10-08'), 'fixed-clock-time');
});

test('present seasonal claims are gated while narrative dates, seasons, numbers and first/last words survive', () => {
  assert.equal(rejection('严寒的冬天已悄悄而至，今天肯德基疯狂星期四，v我50。', '2026-07-09'), 'wrong-season');
  assert.equal(rejection('大抵是冬天到了，v我50让我感到温暖。', '2026-01-08'), '');
  for (const text of [
    '今天是7月11日，我们和平分手。去年7月11日的事还记得。今天疯狂星期四，v我50。',
    '今日是2024年7月11日，我们和平分手。今天疯狂星期四，v我50。',
    '这是我最后一次求你，疯狂星期四请我吃肯德基。',
    '老师问三个学生，第一个学生找来稻草。疯狂星期四，请我吃。',
    '她大一国庆节和我一起回的家，第一次见面的那个秋天，v我50。',
    '2035年将打开异世界的大门，今天疯狂星期四，v我50拯救世界。',
    '蝴蝶效应使得春天来临的速度加快，所以更多鸡肉，疯狂星期四，v我50。',
  ]) assert.equal(rejection(text, '2026-10-08'), '', text);
});
