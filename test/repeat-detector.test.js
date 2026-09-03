import test from 'node:test';
import assert from 'node:assert/strict';
import { RepeatDetector, normalizeRepeatText } from '../src/repeat-detector.js';

function payload(overrides = {}) {
  return {
    messageType: 'group',
    groupId: 'g1',
    userId: 'u1',
    text: '复读内容',
    hasImage: false,
    mentions: [],
    ...overrides,
  };
}

test('同一群两位不同群友复读时只触发一次', () => {
  let now = 1_000;
  const detector = new RepeatDetector({ now: () => now });

  assert.equal(detector.detect(payload({ userId: 'u1' })), null);
  now += 500;
  const repeated = detector.detect(payload({ userId: 'u2' }));
  assert.deepEqual(repeated, {
    text: '复读内容',
    userCount: 2,
    reason: 'cross-user-repeat',
  });
  now += 500;
  assert.equal(detector.detect(payload({ userId: 'u3' })), null);
});

test('连续相同消息不依赖固定时间窗，两位群友即触发', () => {
  let now = 1_000;
  const detector = new RepeatDetector({ now: () => now });

  assert.equal(detector.detect(payload({ userId: 'u1' })), null);
  now += 2 * 60 * 60 * 1000;
  assert.equal(detector.detect(payload({ userId: 'u2' }))?.userCount, 2);
});

test('出现不同内容后结束当前 +1 序列并重新计数', () => {
  let now = 1_000;
  const detector = new RepeatDetector({ now: () => now });

  detector.detect(payload({ userId: 'u1' }));
  now += 100;
  assert.equal(detector.detect(payload({ userId: 'u2', text: '插入内容' })), null);
  now += 100;
  assert.equal(detector.detect(payload({ userId: 'u3' })), null);
  now += 100;
  assert.equal(detector.detect(payload({ userId: 'u4' })).reason, 'cross-user-repeat');
});

test('同一用户连续发送不会被当成群体复读，格式空白会归一化', () => {
  const detector = new RepeatDetector({ now: () => 1_000 });
  assert.equal(normalizeRepeatText('  Hello\n world  '), 'Hello world');
  assert.equal(detector.detect(payload({ userId: 'u1', text: '  Hello ' })), null);
  assert.equal(detector.detect(payload({ userId: 'u1', text: 'Hello' })), null);
  assert.equal(detector.detect(payload({ userId: 'u2', text: 'Hello' })).reason, 'cross-user-repeat');
});
