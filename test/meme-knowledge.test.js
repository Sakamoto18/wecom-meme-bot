import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  MemeKnowledgeStore,
  buildMemeKnowledgeEntry,
  memeKnowledgePrompt,
  reviewMemeKnowledgeReply,
} from '../src/meme-knowledge.js';

function tempDatabase(name) {
  const file = `/tmp/${name}-${process.pid}.sqlite`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  return file;
}

test('高置信陌生梗条目持久化并可复用', () => {
  const store = new MemeKnowledgeStore({ databaseFilePath: tempDatabase('meme-knowledge') });
  const entry = buildMemeKnowledgeEntry('赛博道士', {
    results: [
      { title: '赛博道士是什么意思', description: '网络语境中把修仙和电子设备并置的调侃说法。', url: 'https://baike.baidu.com/item/x' },
      { title: '赛博道士用法', description: '常用于形容穿着或行为同时带有科技和修仙反差的人。', url: 'https://zh.wikipedia.org/wiki/x' },
    ],
  }, { confidence: 'high' });
  assert.equal(store.put(entry), true);
  const hit = store.lookup('赛博道士');
  assert.equal(hit.term, '赛博道士');
  assert.match(memeKnowledgePrompt(hit), /高置信梗库/);
  assert.equal(store.getStats().entries, 1);
  store.close();
});

test('低置信或无来源条目不自动入库', () => {
  const store = new MemeKnowledgeStore({ databaseFilePath: tempDatabase('meme-knowledge-low') });
  const entry = buildMemeKnowledgeEntry('未知词', { context: '只有一条不完整摘要。' }, { confidence: 'medium' });
  assert.equal(store.put(entry), false);
  assert.equal(store.getStats().entries, 0);
  store.close();
});

test('新梗回复检查拦截搜索播报和无来源出处断言', () => {
  const entry = { term: '赛博道士', sourceUrls: [] };
  assert.equal(reviewMemeKnowledgeReply('根据搜索结果，这个梗最早出自某人。', entry).valid, false);
  assert.equal(reviewMemeKnowledgeReply('把修仙和电子设备焊在一起的叫法。', entry).valid, true);
});
