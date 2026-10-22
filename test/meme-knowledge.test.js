import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  MemeKnowledgeStore,
  abstractAssociationPrompt,
  buildAbstractAssociationEntry,
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

test('抽象联想按触发印象持久化、召回并记录反馈', () => {
  const store = new MemeKnowledgeStore({ databaseFilePath: tempDatabase('meme-association') });
  const entry = buildAbstractAssociationEntry({
    trigger: '火柴人弯腰双手前伸，很有恶臭姿势感',
    target: '野兽先辈 / 114514',
    mechanism: '姿势印象加互联网文化密码',
    register: '恶臭梗',
    confidence: 'high',
    usage: ['开始往 114514 那条邪路上长了'],
  });
  assert.equal(store.putAssociation(entry), true);
  const hit = store.lookupAssociations('弯腰双手前伸 恶臭姿势', { limit: 2 });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].target, '野兽先辈 / 114514');
  assert.match(abstractAssociationPrompt(hit), /主观文化线索/u);
  assert.equal(store.recordAssociationFeedback({
    trigger: entry.trigger,
    target: entry.target,
    signal: 'positive',
  }), true);
  assert.equal(store.lookupAssociations('弯腰双手前伸', { limit: 1 })[0].positiveCount, 1);
  const wrong = buildAbstractAssociationEntry({
    trigger: '火柴人弯腰双手前伸，很有恶臭姿势感',
    target: '无关梗',
    mechanism: '碰巧姿势相似',
    confidence: 'high',
  });
  assert.equal(store.putAssociation(wrong), true);
  assert.equal(store.recordAssociationFeedback({
    trigger: wrong.trigger,
    target: wrong.target,
    mechanism: wrong.mechanism,
    signal: 'negative',
  }), true);
  const ranked = store.lookupAssociations('弯腰双手前伸 恶臭姿势', { limit: 2 });
  assert.equal(ranked[0].target, '野兽先辈 / 114514');
  assert.equal(ranked[1].negativeCount, 1);
  store.close();
});
