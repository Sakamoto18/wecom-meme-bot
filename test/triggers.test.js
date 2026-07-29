import test from 'node:test';
import assert from 'node:assert/strict';
import { isLongtuRequest } from '../src/triggers.js';

test('通用表情包词不再触发发图', () => {
  assert.equal(isLongtuRequest('给我来个表情包'), false);
  assert.equal(isLongtuRequest('@机器人 来点好玩的'), false);
  assert.equal(isLongtuRequest('梗图'), false);
});

test('只把明确的龙图指令当作发图请求', () => {
  assert.equal(isLongtuRequest('龙图'), true);
  assert.equal(isLongtuRequest('发张龙图啊'), true);
  assert.equal(isLongtuRequest('@机器人 给我来点龙图！'), true);
  assert.equal(isLongtuRequest('你能不能给我发一个龙图看看'), true);
  assert.equal(isLongtuRequest('来点你那龙图'), true);
  assert.equal(isLongtuRequest('龙图再发两张'), true);
  assert.equal(isLongtuRequest('龙图是什么'), false);
  assert.equal(isLongtuRequest('我不喜欢龙图'), false);
  assert.equal(isLongtuRequest('别给我发龙图'), false);
});
