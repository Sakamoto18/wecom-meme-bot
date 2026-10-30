import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSharedCorrectionFromConversation,
  buildSharedRecurrenceFromConversation,
} from '../src/shared-culture-learning.js';

test('369 纠正会提炼成跨群公开语境卡，不携带成员身份', () => {
  const card = buildSharedCorrectionFromConversation({
    currentText: '他妈他16进8的比赛赢了不就是八强了？你昨天的比赛都不知道？',
    history: [
      { role: 'user', content: '如何看待你9哥进八强了' },
      { role: 'assistant', content: '没查到“9哥”八强记录，暂时无法确认。' },
      { role: 'user', content: '你9哥全名叫369 弱智' },
    ],
  });
  assert.ok(card);
  assert.equal(card.normalizedTopic, '369');
  assert.ok(card.terms.includes('9哥'));
  assert.match(card.descriptors[0], /16进8|八强/);
  assert.doesNotMatch(card.descriptors.join(' '), /913546080|成员-|QQ号/);
  assert.equal(card.lookupSource, 'group-correction');
});

test('普通追问或缺少公开锚点时不自动入共享卡', () => {
  assert.equal(buildSharedCorrectionFromConversation({
    currentText: '你昨天都不知道？',
    history: [{ role: 'assistant', content: '我不清楚。' }],
  }), null);
  assert.equal(buildSharedCorrectionFromConversation({
    currentText: '不对，你理解错了',
    history: [{ role: 'assistant', content: '这个说法不对。' }],
  }), null);
});

test('重复公共梗会形成脱敏跨群语境卡', () => {
  const card = buildSharedRecurrenceFromConversation({
    currentText: '九妹九妹，上路的堡垒',
    history: [],
  });
  assert.ok(card);
  assert.equal(card.normalizedTopic, '九妹');
  assert.equal(card.lookupSource, 'group-recurrence');
  assert.equal(card.evidenceQuality, 'conversation-recurrence');
  assert.match(card.descriptors[0], /九妹九妹/);
  assert.doesNotMatch(card.descriptors.join(' '), /成员-|QQ号|群号/);
  assert.equal(buildSharedRecurrenceFromConversation({
    currentText: '哈哈哈哈，这也太好笑了',
    history: [],
  }), null);
});

