import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { CultureCache, buildCultureCard, cultureCardPrompt } from '../src/culture-cache.js';

function tempDatabase(name) {
  const file = `/tmp/${name}-${process.pid}.sqlite`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  return file;
}

test('文化缓存只保存短卡并支持精确和 FTS 召回', () => {
  const databaseFilePath = tempDatabase('longtu-culture');
  const cache = new CultureCache({ databaseFilePath });
  const card = buildCultureCard('亡灵骑士', {
    results: [{
      title: '女鬼电梯语境',
      description: '进入女鬼电梯后，通过双关转职成亡灵骑士。',
      url: 'https://example.com/meme',
    }],
  });
  assert.ok(card);
  assert.equal(cache.put(card), true);
  assert.equal(cache.lookup('亡灵骑士')?.topicKey, '亡灵骑士');
  assert.equal(cache.lookup('女鬼电梯')?.topicKey, '亡灵骑士');
  assert.match(cultureCardPrompt(cache.lookup('亡灵骑士')), /本地缓存短卡/);
  assert.equal(cache.getStats().topics, 1);
  cache.close();
});

test('只有 context 的搜索结果也只提炼有限文化描述', () => {
  const card = buildCultureCard('网络热梗', {
    context: '公开摘要：这个梗通过反差和双关流传，网页正文不应原样进入缓存。',
  });
  assert.ok(card);
  assert.ok(card.descriptors.length > 0);
  assert.ok(card.descriptors.every((value) => value.length <= 180));
});
