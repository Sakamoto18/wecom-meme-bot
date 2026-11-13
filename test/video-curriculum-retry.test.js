import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VideoLearningStore } from '../src/video-learning-store.js';
import { VideoCurriculumRetry, parseCurriculumRetry } from '../src/video-curriculum-retry.js';

const scope = { chatType: 'group', groupId: 'g', userId: 'admin', botUserId: 'bot' };
const videos = [
  { bvid: 'BV1aa411c7xx', title: '失败梗', status: 'failed', error: 'HTTP 412' },
  { bvid: 'BV1bb411c7yy', title: '已学会', status: 'learned' },
  { bvid: 'BV1cc411c7zz', title: '候选梗', status: 'candidate' },
];
function setup(t) {
  let now = Date.parse('2026-11-13T04:00:00+08:00');
  const dir = mkdtempSync(path.join(tmpdir(), 'retry-learning-'));
  const store = new VideoLearningStore({ databaseFilePath: path.join(dir, 'db'), now: () => now });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const watched = [];
  const c = { store, curriculum: { mid: '123' }, now: () => now,
    limits: { dailyTasks: 10, dailyMaterialSeconds: 1800, taskMaterialSeconds: 300 },
    async processTask(task) {
      watched.push(task);
      store.updateTask(task.taskKey, { status: 'completed', result: { materialSeconds: 30,
        entry: { term: task.topic, meaning: '梗义', verified: true } } });
    } };
  const archive = (day, items = videos) => store.enqueueDailyReport(`curriculum-report:123:${day}:admin:${now}`, {
    reportItems: items, reportText: `每日梗百科学习报告 ${day}`, chatType: 'private', userId: 'admin',
  });
  archive('2026-11-12');
  for (const delivery of store.claimDeliveries()) store.completeDelivery(delivery.deliveryId);
  return { c, store, watched, archive, retry: new VideoCurriculumRetry(c), advance: ms => { now += ms; } };
}

test('自然重学语句与日期按中国时间解析，非法日期明确报错', () => {
  const now = Date.parse('2026-11-12T18:00:00Z');
  assert.deepEqual(parseCurriculumRetry('重学昨天失败的视频', now), { action: 'retry', day: '2026-11-12' });
  assert.deepEqual(parseCurriculumRetry('补学2026-11-05日报里失败的视频'), { action: 'retry', day: '2026-11-05' });
  assert.deepEqual(parseCurriculumRetry('/learn-retry'), { action: 'retry', day: '' });
  assert.equal(parseCurriculumRetry('/learn-retry 2026-02-30').action, 'invalid');
  assert.equal(parseCurriculumRetry('补学进度').action, 'status');
  assert.equal(parseCurriculumRetry('有人说重学昨天失败的视频'), null);
});

test('只补学日报失败项，沿用审核，独立报告且不覆盖原日报', async t => {
  const f = setup(t);
  const original = f.store.curriculumReport('123', '2026-11-12');
  assert.match(f.retry.handle({ action: 'retry', day: '2026-11-12' }, scope), /1 个视频/);
  assert.match(f.retry.handle({ action: 'retry', day: '2026-11-12' }, scope), /已有补学/);
  await f.retry.tick();
  assert.equal(f.watched.length, 1);
  assert.equal(f.watched[0].metadata.preferredBvid, videos[0].bvid);
  assert.equal(f.watched[0].metadata.directLink, true);
  assert.deepEqual(f.watched[0].metadata.waiters, []);
  const [delivery] = f.store.claimDeliveries();
  assert.equal(delivery.payload.groupId, scope.groupId);
  assert.equal(delivery.payload.reportImage, true);
  assert.deepEqual(delivery.payload.reportItems.map(i => i.title), ['失败梗']);
  assert.match(delivery.payload.reportText, /学会 1，候选 0，失败 0/);
  assert.deepEqual(f.store.curriculumReport('123', '2026-11-12'), original);
  f.store.completeDelivery(delivery.deliveryId);
  await new VideoCurriculumRetry(f.c).tick();
  assert.equal(f.store.claimDeliveries().length, 0);
  assert.match(f.retry.handle({ action: 'retry' }, scope), /没有需要补学/);
  assert.match(f.retry.handle({ action: 'status' }, scope), /失败视频补学报告/);
});

test('历史日报可找回，当前正在运行的日报不可补学；获取列表失败不伪造视频', t => {
  const f = setup(t);
  f.store.saveProgress('bilibili-space:123', { run: { day: '2026-11-13', status: 'running', items: videos } });
  assert.match(f.retry.handle({ action: 'retry' }, scope), /还没结束/);
  assert.match(f.retry.handle({ action: 'retry', day: '2026-11-12' }, scope), /1 个视频/);
  f.archive('2026-11-10', []);
  assert.match(f.retry.handle({ action: 'retry', day: '2026-11-10' }, scope), /获取列表/);
  assert.match(f.retry.handle({ action: 'retry', day: '2020-01-01' }, scope), /没找到/);
});

test('预算不足保留批次，重启次日继续，任务完成后崩溃不重复观看', async t => {
  const f = setup(t);
  f.c.limits.dailyMaterialSeconds = 10;
  f.retry.handle({ action: 'retry' }, scope);
  await f.retry.tick();
  assert.equal(f.watched.length, 0);
  assert.match(f.retry.handle({ action: 'status' }, scope), /预算已用完/);
  f.advance(86400_000); f.c.limits.dailyMaterialSeconds = 1800;
  const save = f.retry.save.bind(f.retry);
  f.retry.save = batch => { if (batch.items.length) throw new Error('模拟进程退出'); save(batch); };
  await assert.rejects(f.retry.tick(), /模拟进程退出/);
  assert.equal(f.watched.length, 1);
  f.store.close();
  await new VideoCurriculumRetry(f.c).tick();
  assert.equal(f.watched.length, 1);
  assert.equal(f.store.claimDeliveries()[0].payload.reportItems.length, 1);
});

test('仍失败可再次补学，候选保持待审核，官方私聊回到官方 OpenID', async t => {
  const f = setup(t);
  const official = { chatType: 'private', userId: '1079175957', botUserId: 'qqofficial:123:user:bot',
    deliveryUserId: 'qqofficial:123:user:openid' };
  f.c.processTask = async task => { f.watched.push(task); f.store.updateTask(task.taskKey, { status: 'failed', error: 'HTTP 412' }); };
  f.retry.handle({ action: 'retry' }, official); await f.retry.tick();
  assert.match(f.retry.handle({ action: 'status' }, official), /HTTP 412/);
  f.advance(1000);
  assert.match(f.retry.handle({ action: 'retry' }, official), /1 个视频/);
  f.c.processTask = async task => { f.watched.push(task); f.store.updateTask(task.taskKey, { status: 'completed',
    result: { entry: { confidence: 'medium', verified: false, meaning: '未确认梗义' } } }); };
  await f.retry.tick();
  assert.notEqual(f.watched[0].taskKey, f.watched[1].taskKey);
  const deliveries = f.store.claimDeliveries();
  assert.equal(deliveries.length, 2);
  assert.ok(deliveries.every(d => d.payload.userId === official.deliveryUserId));
  assert.equal(deliveries[1].payload.reportItems[0].status, 'candidate');
  assert.match(f.retry.handle({ action: 'retry' }, official), /没有需要补学/);
});
