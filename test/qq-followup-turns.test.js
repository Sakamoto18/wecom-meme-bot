import test from 'node:test';
import assert from 'node:assert/strict';
import { QqFollowupTurns } from '../src/qq-followup-turns.js';
const payload = (patch = {}) => ({ messageType: 'group', groupId: 'g', userId: 'u', botUserId: 'bot',
  mentions: [], imageBase64s: [], quotedImageBase64s: [], text: '', ...patch });

test('补充只跟随同人同群同 bot；超时、命令、其他被 @ 者不合并', () => {
  let now = 0;
  const turns = new QqFollowupTurns({ now: () => now });
  turns.accept(payload({ pureBotMention: true }), { direct: true });
  for (const patch of [{ userId: 'other' }, { groupId: 'other' }, { botUserId: 'other' }]) {
    assert.equal(turns.accept(payload({ ...patch, text: '新问题' })), null);
  }
  assert.equal(turns.accept(payload({ text: '/stop' }), { command: true }), null);
  assert.equal(turns.accept(payload({ text: '问别人', mentions: [{ userId: 'other' }] })), null);
  now = 30001;
  assert.equal(turns.accept(payload({ text: '已经过时' })), null);
});

test('原图和引用随补充保留，多段有界，重复消息不抢占', () => {
  const turns = new QqFollowupTurns();
  const first = turns.accept(payload({ text: '看这图', messageId: '1', imageBase64s: ['image'], hasImage: true,
    quotedText: '资料', quotedAuthor: { userId: 'bot' } }), { direct: true });
  assert.equal(turns.accept(payload({ messageId: '1' })).duplicate, true);
  assert.equal(first.stale(), false);
  const next = payload({ text: '出自什么游戏', messageId: '2', observeOnly: true });
  const second = turns.accept(next);
  assert.equal(first.stale(), true);
  assert.deepEqual(next.imageBase64s, ['image']);
  assert.equal(next.quotedText, '资料');
  assert.equal(next.text, '看这图\n出自什么游戏');
  assert.equal(next.observeOnly, false);
  first.finish();
  assert.equal(turns.turns.size, 1);
  second.finish();
  assert.equal(turns.turns.size, 0);
});
