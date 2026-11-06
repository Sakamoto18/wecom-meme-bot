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
  assert.equal(store.lookupAssociations('这个火柴人弯腰双手前伸你想到了什么')[0].target, entry.target);
  assert.equal(store.lookupAssociations('今天天气怎么样').length, 0);
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

test('新闻型抽象联想会保存现实锚点、梗改写和信息类型', () => {
  const store = new MemeKnowledgeStore({ databaseFilePath: tempDatabase('meme-association-news') });
  const entry = buildAbstractAssociationEntry({
    trigger: '完整私钥被拿来当恋爱门槛，最后只回4',
    target: 'PHP2Shell 重大漏洞梗',
    mechanism: '用弱私钥/补丁门槛的反差抽象化近期 PHP 漏洞',
    register: '技术新闻抽象梗',
    realityAnchor: '2026-10-21 PHP2Shell，CVE-2026-109618/109619，未授权 RCE',
    memeClaim: '把补丁和密钥强度的现实门槛改写成恋爱门槛',
    informationKind: 'news',
    confidence: 'high',
  });
  assert.equal(store.putAssociation(entry), true);
  const [hit] = store.lookupAssociations('完整私钥 PHP2Shell 漏洞', { limit: 1 });
  assert.equal(hit.realityAnchor, entry.realityAnchor);
  assert.equal(hit.memeClaim, entry.memeClaim);
  assert.equal(hit.informationKind, 'news');
  const prompt = abstractAssociationPrompt([hit]);
  assert.match(prompt, /现实锚点：2026-10-21 PHP2Shell/);
  assert.match(prompt, /梗的改写：/);
  assert.match(prompt, /信息类型：news/);
  store.close();
});


test('视频候选全局召回但不冒充高置信知识；可晋升且不可覆盖已核实条目', () => {
  let now = Date.now();
  const file = tempDatabase('video-candidate');
  const store = new MemeKnowledgeStore({ databaseFilePath: file, now: () => now });
  const entry = { term: '灭建国', aliases: ['建国灭霸'], meaning: '外国超级英雄配上中式年代人名的反差',
    usage: ['给洋气角色配一个土气名字'], confidence: 'medium', verified: false, lookupSource: 'video',
    sourceDomains: ['bilibili.com'], sourceUrls: ['https://www.bilibili.com/video/BV1Epx96EEBG'],
    lyrics: [{ line: '未经核实的歌词' }], replyHooks: ['未经核实的原句'] };
  assert.equal(store.put(entry), false);
  assert.equal(store.putCandidate(entry), true);
  store.close();
  const hit = store.lookupPhrase('怎么又来建国灭霸了');
  assert.equal(hit.confidence, 'medium');
  assert.equal(hit.verified, false);
  assert.deepEqual(hit.lyrics, []);
  assert.deepEqual(hit.replyHooks, []);
  assert.match(memeKnowledgePrompt(hit), /全局候选梗记忆（事实待核实）/);
  assert.doesNotMatch(memeKnowledgePrompt(hit), /本地高置信梗库/);
  assert.equal(store.listAssociationCandidates(48, '灭建国')[0].source, 'video-candidate');
  assert.equal(store.put({ ...entry, confidence: 'high' }), true);
  assert.equal(store.putCandidate(entry), false);
  assert.equal(store.lookup('灭建国').confidence, 'high');
  now += 400 * 86400000;
  assert.equal(store.lookup('灭建国'), null);
  assert.equal(store.listAssociationCandidates().length, 0);
  store.close();
});
