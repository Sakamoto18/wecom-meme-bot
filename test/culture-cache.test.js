import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  CultureCache,
  buildCultureCard,
  buildSharedCultureCorrectionCard,
  cultureCardPrompt,
  evaluateCultureEvidence,
} from '../src/culture-cache.js';

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

test('文化短卡保存领域和贴吧来源，并按领域召回', () => {
  const databaseFilePath = tempDatabase('longtu-culture-domain');
  const cache = new CultureCache({ databaseFilePath });
  const card = buildCultureCard('龙图', {
    results: [{
      title: '龙图语境',
      description: '公开贴吧中用于表达特定反差和接梗语境。',
      url: 'https://tieba.baidu.com/p/123',
    }],
  }, { domain: 'longtu', lookupSource: 'tieba', confidence: 'high' });
  assert.equal(cache.put(card), true);
  const hit = cache.lookup('龙图', { domain: 'longtu' });
  assert.equal(hit.domain, 'longtu');
  assert.equal(hit.lookupSource, 'tieba');
  assert.match(cultureCardPrompt(hit), /公开贴吧语境证据/);
  assert.equal(cache.lookup('龙图', { domain: 'general' }), null);
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

test('具体梗名没有出现在结果中时不建立精确文化短卡', () => {
  const card = buildCultureCard('突然的陀螺', {
    results: [{
      title: '突然的自我',
      description: '一段相似的网络语境说明。',
      url: 'https://example.com/related',
    }],
  }, { exactQuery: '突然的陀螺', requireExactMatch: true });
  assert.equal(card, null);
  assert.equal(evaluateCultureEvidence('突然的陀螺', {
    results: [{ title: '突然的自我', description: '相似语境', url: 'https://example.com/related' }],
  }).evidenceQuality, 'related-only');
});

test('精确标题和可信来源会标记证据质量', () => {
  const exact = buildCultureCard('突然的陀螺', {
    results: [{
      title: '突然的陀螺是什么梗',
      description: '固定说法，指话题突然转向。',
      url: 'https://example.com/meme',
    }],
  }, { exactQuery: '突然的陀螺', requireExactMatch: true });
  assert.equal(exact.evidenceQuality, 'exact-match');
  assert.equal(exact.exactMatch, true);

  const bilibili = evaluateCultureEvidence('突然的陀螺', {
    results: [{
      title: '突然的陀螺原视频',
      description: '相关语境',
      url: 'https://www.bilibili.com/video/BV123',
    }],
  });
  assert.equal(bilibili.evidenceQuality, 'exact-source');
});

test('空查询不会因为 includes 空字符串误判为精确匹配', () => {
  const evidence = evaluateCultureEvidence('', {
    context: '任何搜索摘要',
    results: [{ title: '任意标题', description: '任意摘要' }],
  });
  assert.equal(evidence.exactMatch, false);
  assert.equal(evidence.evidenceQuality, 'related-only');
});

test('跨群纠正卡只保存公开语境并优先于歧义旧卡', () => {
  const databaseFilePath = tempDatabase('shared-culture-correction');
  const cache = new CultureCache({ databaseFilePath });
  const old = buildCultureCard('369 9哥 梗 出处', {
    results: [{
      title: '三六九帮派与不要迷恋哥',
      description: '与电竞语境无关的相似结果。',
      url: 'https://example.com/old',
    }],
  });
  assert.equal(cache.put(old), true);
  const card = buildSharedCultureCorrectionCard({
    topic: '369',
    aliases: ['9哥'],
    context: '纠正要点：16进8赢了就是进入八强；关联公开语境：如何看待你9哥进八强了',
  });
  assert.equal(cache.put(card), true);
  const hit = cache.lookup('369');
  assert.equal(hit.lookupSource, 'group-correction');
  assert.equal(hit.evidenceQuality, 'conversation-correction');
  assert.equal(cache.lookup('369 9哥 梗 出处')?.lookupSource, 'group-correction');
  assert.match(cultureCardPrompt(hit), /跨群共享/);
  assert.doesNotMatch(cultureCardPrompt(hit), /913546080|成员-[a-f0-9]{6,12}/u);
  cache.close();
});
