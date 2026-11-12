import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemeKnowledgeStore } from '../src/meme-knowledge.js';
import { VideoLearningStore } from '../src/video-learning-store.js';
import { WebMemeLearning, parseWebMemeLearningRequest, validateWebMemeReview } from '../src/web-meme-learning.js';

const sources = [
  { id: 1, url: 'https://a.example.org/source', domain: 'a.example.org', title: '肥嘟嘟梗解释', text: '肥嘟嘟这个梗用可爱的叠词调侃大胆行为，常用于朋友之间开玩笑，而非严肃威胁。这里介绍了这个词语的日常使用场景。' },
  { id: 2, url: 'https://other.net/source', domain: 'other.net', title: '肥嘟嘟的用法', text: '肥嘟嘟是在别人做出大胆举动时使用的玩笑说法，用叠词减轻凶狠语气，适合熟人调侃。注意不要用在严肃争论当中。' },
];
const draft = { claims: [
  { kind: 'meaning', text: '用软萌叠词调侃大胆行为。', evidence: sources.map(s => ({ sourceId: s.id, quote: s.text })) },
  { kind: 'usage', text: '朋友做出大胆举动时用于调侃。', evidence: [{ sourceId: 2, quote: sources[1].text }] },
  { kind: 'origin', text: '源于未经核实的电影。', evidence: [{ sourceId: 1, quote: '这是网页根本没有说过的所谓电影来源' }] },
], uncertainties: ['起源尚未核实'] };
const review = { confidence: 'high', approvedClaims: [0, 1, 2], independentSources: true, reason: '核心含义和使用场景由不同来源互证。' };

test('明确命令与自然语言入口，不抢普通问梗和视频学习', () => {
  for (const text of ['/learn-meme 肥嘟嘟', '联网学习 肥嘟嘟 这个梗', '帮我去网上学习一下“肥嘟嘟”这个梗', '学一下肥嘟嘟这个梗']) {
    assert.deepEqual(parseWebMemeLearningRequest(text), { term: '肥嘟嘟' }, text);
  }
  for (const text of ['肥嘟嘟是什么梗', '学习一下这个视频 https://b23.tv/abc', '我今天学了一个梗', '/learn-memes foo']) assert.equal(parseWebMemeLearningRequest(text), null);
  assert.ok(parseWebMemeLearningRequest('/learn-meme').error);
  assert.ok(parseWebMemeLearningRequest('联网学习这个梗').error);
  assert.ok(parseWebMemeLearningRequest('/learn-meme https://example.com').error);
});

test('审核剔除伪造引文，同站子域、单来源、审核拒绝不能高置信入库', () => {
  const good = validateWebMemeReview(draft, review, sources);
  assert.equal(good.confidence, 'high');assert.equal(good.claims.length, 2);
  for (const result of [
    validateWebMemeReview(draft, review, sources.slice(0, 1)),
    validateWebMemeReview(draft, review, sources.map(s => ({ ...s, domain: `${s.id}.example.org` }))),
    validateWebMemeReview(draft, { ...review, independentSources: false }, sources),
    validateWebMemeReview(draft, { ...review, confidence: 'low' }, sources),
    validateWebMemeReview(draft, { ...review, approvedClaims: [2, 999] }, sources),
    validateWebMemeReview({ claims: [draft.claims[0]] }, review, sources),
  ]) assert.notEqual(result.confidence, 'high');
});

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'web-meme-'));
  const memeKnowledge = new MemeKnowledgeStore({ databaseFilePath: path.join(directory, 'knowledge.sqlite') });
  const store = new VideoLearningStore({ databaseFilePath: path.join(directory, 'learning.sqlite') });
  t.after(() => { memeKnowledge.close();store.close();rmSync(directory, { recursive: true, force: true }); });
  const searches = [], calls = [];
  const learner = new WebMemeLearning({ store, memeKnowledge, logger: { warn() {} },
    webSearch: { async search(term, options) { searches.push({ term, options });return { results: sources.map(s => ({ ...s, description: s.text })) }; } },
    chatClient: { isConfigured: true, async complete(_h, input, options) {
      calls.push({ input, options });
      return JSON.stringify(options.usageSource.endsWith('draft') ? draft : review);
    } }, ...overrides,
  });
  return { learner, store, memeKnowledge, searches, calls };
}
const scope = { chatType: 'group', groupId: 'qqofficial:1903660238:group:example', userId: 'member' };

test('强制检索、两阶段审核、真实梗库更新和报告存档；冷却按群执行', async t => {
  const f = fixture(t);
  f.memeKnowledge.put({ term: '肥嘟嘟', meaning: '旧的解释内容', confidence: 'high', sourceDomains: ['old.test'] });
  const report = await f.learner.learn('肥嘟嘟', scope);
  assert.match(report, /已通过审核并更新共享梗库/);
  assert.match(report, /起源尚未核实/);assert.doesNotMatch(report, /源于未经核实的电影/);
  assert.equal(f.searches.length, 2);assert.ok(f.searches.every(c => c.options.forceRefresh === true));
  assert.equal(f.calls.length, 2);assert.ok(f.calls[1].input.includes('claims'));
  const entry = f.memeKnowledge.lookup('肥嘟嘟');
  assert.match(entry.meaning, /软萌/);assert.equal(entry.lookupSource, 'web-reviewed');assert.equal(entry.usage.length, 1);
  const id = report.match(/报告编号：([^\n]+)/u)[1];
  const saved = f.store.getProgress(`web-meme-report:${id}`);
  assert.equal(saved.status, 'done');assert.equal(saved.saved, true);assert.equal(saved.scope.groupId, scope.groupId);
  assert.match(await f.learner.learn('其他梗', { ...scope, userId: 'another' }), /一分钟/);
  assert.equal(f.searches.length, 2);
});

test('低置信、格式错误、网络失败均返回报告且不覆盖旧知识', async t => {
  for (const failure of ['medium', 'malformed', 'network', 'write']) {
    await t.test(failure, async t => {
      const f = fixture(t);
      f.memeKnowledge.put({ term: '肥嘟嘟', meaning: '旧知识仍然有效', confidence: 'high', sourceDomains: ['old.test'] });
      if (failure === 'network') f.learner.webSearch.search = async () => { throw new Error('network'); };
      else if (failure === 'write') f.memeKnowledge.put = () => false;
      else f.learner.chatClient.complete = async (_h, _i, o) => o.usageSource.endsWith('draft') ? JSON.stringify(draft)
        : failure === 'malformed' ? 'invalid json' : JSON.stringify({ ...review, confidence: 'medium' });
      const report = await f.learner.learn('肥嘟嘟', scope);
      assert.match(report, /未入库/);assert.match(report, /报告编号/);
      assert.equal(f.memeKnowledge.lookup('肥嘟嘟').meaning, '旧知识仍然有效');
    });
  }
});

test('相同网页正文不算两个独立来源', async t => {
  const f = fixture(t);
  f.learner.webSearch.search = async () => ({ results: sources.map(s => ({ ...s, description: sources[0].text })) });
  const report = await f.learner.learn('肥嘟嘟', scope);
  assert.match(report, /未入库/);assert.equal(f.memeKnowledge.lookup('肥嘟嘟'), null);
});

test('并发时相同梗不重复检索，搜索额度耗尽会报告失败', async t => {
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.learner.webSearch.search = async () => { await gate;return { results: sources.map(s => ({ ...s, description: s.text })) }; };
  const pending = f.learner.learn('肥嘟嘟', scope);
  assert.match(await f.learner.learn('肥嘟嘟', { ...scope, groupId: 'another' }), /正在学习/);
  release();await pending;
  f.learner.webSearch.search = async () => { throw Object.assign(new Error('quota'), { name: 'QqUsageLimitError' }); };
  assert.match(await f.learner.learn('新词', { ...scope, groupId: 'another' }), /额度不足/);
  assert.equal(f.memeKnowledge.lookup('新词'), null);
});
