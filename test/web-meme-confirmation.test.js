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
