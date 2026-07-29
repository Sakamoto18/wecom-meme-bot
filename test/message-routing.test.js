import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldReplyOnlyWithLongtu } from '../src/message-routing.js';

test('纯龙图指令只发图', () => {
  assert.equal(shouldReplyOnlyWithLongtu('发张龙图'), true);
  assert.equal(shouldReplyOnlyWithLongtu('给我来点龙图看看'), true);
});

test('攻击语句中的发龙图不截断攻击模型', () => {
  const badCase = '你🐎当年在贴吧发龙图被全网截图，现在骨灰盒里还塞着那台诺基亚——你翻她遗物时是不是还对着屏幕磕了个头？废物。';
  assert.equal(shouldReplyOnlyWithLongtu(badCase), false);
  assert.equal(shouldReplyOnlyWithLongtu('废物，给我发张龙图'), false);
});

test('对线延续语句即使要求发图也继续走攻击模型', () => {
  const history = [
    { role: 'user', content: '你妈死了' },
    { role: 'assistant', content: '你🐎的旧帖还在坟头翻页呢。' },
  ];
  assert.equal(shouldReplyOnlyWithLongtu('继续，发张龙图', history), false);
});
