import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemeKnowledgeStore, memeKnowledgePrompt } from '../src/meme-knowledge.js';
import { VideoLearningStore } from '../src/video-learning-store.js';
import { WebMemeConfirmation, parseWebMemeManagement } from '../src/web-meme-confirmation.js';
const scope = { chatType: 'group', groupId: 'group', userId: 'admin' };
function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'manual-meme-'));
  const store = new VideoLearningStore({ databaseFilePath: path.join(dir, 'reports.sqlite') });
  const memeKnowledge = new MemeKnowledgeStore({ databaseFilePath: path.join(dir, 'knowledge.sqlite') });
  t.after(() => { store.close();memeKnowledge.close();rmSync(dir, { recursive: true, force: true }); });
  let now = Date.now();
  const manager = new WebMemeConfirmation({ store, memeKnowledge, now: () => now });
  const report = { id: 'test-id', term: '哼哼啊啊', startedAt: now, finishedAt: now, status: 'done', confidence: 'low', saved: false, scope,
    claims: [{ kind: 'meaning', text: '这段声音关联野兽先辈梗', sourceIds: [1] }, { kind: 'origin', text: '没有核实的出处', sourceIds: [1] }],
    sources: [{ id: 1, domain: 'example.com', url: 'https://example.com', title: '资料' }] };
  store.saveProgress('web-meme-report:test-id', report);
  const call = (text, who = scope, admin = true, quote = {}) => manager.handle(parseWebMemeManagement(text), who, { administrator: admin, ...quote });
  return { manager, store, memeKnowledge, report, call, advance: ms => now += ms };
}
test('管理员预览与确认，机器低置信保留，只入库选中内容，重复确认不重复写', t => {
  const f = setup(t);
  assert.match(f.call('/learn-review 最近', scope, false), /只有/);
  assert.match(f.call('/learn-list'), /#1 哼哼啊啊/);
  assert.match(f.call('/learn-review #1'), /尚未入库/);
  assert.equal(f.memeKnowledge.lookup('哼哼啊啊'), null);
  assert.match(f.call('/learn-confirm', { ...scope, userId: 'another' }), /没有有效预览/);
  assert.match(f.call('/learn-confirm'), /已人工确认入库/);
  const entry = f.memeKnowledge.lookup('哼哼啊啊');
  assert.equal(entry.lookupSource, 'human-confirmed');assert.doesNotMatch(entry.meaning, /出处/);
  assert.match(memeKnowledgePrompt(entry), /管理员人工确认/);
  const r = f.store.getProgress('web-meme-report:test-id');
  assert.equal(r.confidence, 'low');assert.equal(r.manualConfirmation.userId, 'admin');
  assert.match(f.call('/learn-confirm'), /没有有效预览/);
  assert.match(f.call('/learn-report #1'), /已人工确认/);
});
test('序号快照不随新任务变化，同名多份要求选时间；会话隔离和引用失败不猜最近', t => {
  const f = setup(t);f.call('/learn-list');
  f.store.saveProgress('web-meme-report:new', { ...f.report, id: 'new', startedAt: f.report.startedAt + 1000 });
  assert.match(f.call('/learn-review 哼哼啊啊'), /多份报告/);
  assert.match(f.call('/learn-review #1 | 只确认这是野兽先辈梗'), /只确认这是野兽先辈梗/);
  assert.match(f.call('/learn-review', scope, true, { quotedMessageId: 'image-id' }), /无法识别/);
  assert.match(f.call('/learn-review 最近', { ...scope, groupId: 'other' }), /找不到/);
  assert.match(f.call('/learn-confirm'), /没有有效预览/);
  f.call('/learn-review #1 | 只确认这是野兽先辈梗');
  assert.match(f.call('/learn-confirm'), /已人工确认/);
  assert.equal(f.store.getProgress('web-meme-report:test-id').saved, true);
  assert.equal(f.store.getProgress('web-meme-report:new').saved, false);
});
test('并发改动、取消、过期、写入失败不伪报成功', t => {
  const f = setup(t);f.call('/learn-review 最近');
  f.store.saveProgress('web-meme-report:test-id', { ...f.report, reason: 'changed' });
  assert.match(f.call('/learn-confirm'), /报告已变化/);
  f.call('/learn-review 最近');
  f.memeKnowledge.put({ term: f.report.term, meaning: '新知识不能误覆盖', confidence: 'high', sourceDomains: ['example.com'] });
  assert.match(f.call('/learn-confirm'), /已被其他任务更新/);
  f.call('/learn-review 最近');f.call('/learn-cancel');assert.match(f.call('/learn-confirm'), /没有有效预览/);
  f.call('/learn-list');f.call('/learn-review #1');f.advance(11 * 60_000);assert.match(f.call('/learn-confirm'), /超过/);
  f.advance(20 * 60_000);assert.match(f.call('/learn-review #1'), /序号已过期/);
  f.call('/learn-review 最近');f.memeKnowledge.put = () => false;
  assert.match(f.call('/learn-confirm'), /写入失败/);
  assert.equal(f.store.getProgress('web-meme-report:test-id').saved, false);
});
test('重启后可确认自己的快照，私聊记录隔离，失败任务需具体结论', t => {
  const f = setup(t);
  f.store.saveProgress('web-meme-report:test-id', { ...f.report, status: 'failed', claims: [] });
  assert.match(f.call('/learn-review 最近'), /没有可保存/);
  assert.match(f.call('/learn-review 最近 | 这是野兽先辈梗的声音关联'), /尚未入库/);
  const restarted = new WebMemeConfirmation({ store: f.store, memeKnowledge: f.memeKnowledge });
  assert.match(restarted.handle({ action: 'confirm', argument: '' }, scope, { administrator: true }), /已人工确认/);
  f.store.saveProgress('web-meme-report:private', { ...f.report, id: 'private', scope: { chatType: 'private', userId: 'admin' } });
  assert.equal(f.store.listWebMemeReports({ chatType: 'private', userId: 'another' }).length, 0);
});

test('管理员自然回复一步入库，普通聊天和否定不触发', t => {
  const f = setup(t);
  for (const text of ['入库', '确认入库', '这个我确认了', '这份入库吧']) assert.equal(parseWebMemeManagement(text)?.action, 'direct');
  for (const text of ['不要入库', '能入库吗', '对的话我确认一下就能入库', '入库失败了吗']) assert.equal(parseWebMemeManagement(text), null);
  assert.match(f.call('入库', scope, false), /只有已配置/);
  assert.match(f.call('入库'), /已人工确认入库/);
  assert.match(f.call('入库'), /已经入库/);
  assert.equal(f.memeKnowledge.lookup('哼哼啊啊').lookupSource, 'human-confirmed');
});
test('引用标题或报告图精准选择旧报告，多份不猜，未知引用不落到最近', t => {
  const f = setup(t);
  f.store.saveProgress('web-meme-report:new', { ...f.report, id: 'new', term: '另一个梗' });
  assert.match(f.call('入库'), /几份报告/);
  assert.match(f.call('入库', scope, true, { quotedMessageId: 'unknown' }), /引用没能对应/);
  assert.match(f.call('入库', scope, true, { quotedMessageId: 'old', quotedText: '《哼哼啊啊》学习报告\n管理员回复入库' }), /已人工确认入库/);
  assert.equal(f.store.getProgress('web-meme-report:new').saved, false);
  assert.match(f.call('入库 另一个梗'), /已人工确认入库/);
});
test('持久化报告图片引用与会话隔离，图片预览只保存预览内容', t => {
  const f = setup(t); const id = '23198fa3-3040-4214-9305-dd0626e3090f';
  f.store.saveProgress(`web-meme-report:${id}`, { ...f.report, id, term: '图片报告' });
  const preview = f.call('/learn-review 图片报告 | 这段声音属于野兽先辈梗');
  const image = Buffer.from('test-image').toString('base64');
  f.manager.rememberReportImage(scope, preview, image);
  f.call('/learn-cancel');
  assert.match(f.call('入库', { ...scope, groupId: 'other' }, true, { quotedMessageId: 'image', quotedImages: [image] }), /引用没能对应/);
  assert.match(f.call('入库', scope, true, { quotedMessageId: 'image', quotedImages: [image] }), /已人工确认入库/);
  assert.equal(f.memeKnowledge.lookup('图片报告').meaning, '这段声音属于野兽先辈梗');
});
