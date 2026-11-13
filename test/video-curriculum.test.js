import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VideoLearningStore } from '../src/video-learning-store.js';
import { VideoCurriculum } from '../src/video-curriculum.js';
import { VideoLearningCoordinator } from '../src/video-learning.js';

test('主页获取不到登录态时暂停，不能匿名请求列表', async () => {
  const coordinator = Object.create(VideoLearningCoordinator.prototype);
  coordinator.cookieProvider = async () => '';
  coordinator.store = {};
  coordinator.fetchImpl = async () => { throw new Error('不应请求 B 站'); };
  const curriculum = new VideoCurriculum(coordinator, { mid: '123', recipients: ['456'] });
  await assert.rejects(curriculum.page(2), error => error.retryable && /未使用匿名请求/.test(error.message));
});

test('412 冷却后续学，进程重启保留等待时间和队列', async t => {
  const f = fixture(t);const c = f.make();
  c.page = async () => { throw new Error('HTTP 412'); };
  await c.tick();
  assert.equal(f.store.getProgress(c.key).run.status, 'retry-wait');
  assert.equal(f.store.claimDeliveries().length, 0);
  await f.make().tick();assert.equal(f.watched.length, 0);
  f.advance(30 * 60_000);await f.make().tick();
  assert.equal(f.watched.length, 1);
  assert.equal(f.store.getProgress(c.key).run.error, undefined);
});

test('持续风控最多补试两次后报告，临时补学上限不改变每日配置', async t => {
  const f=fixture(t);const c=f.make();let calls=0;
  c.page=async()=>{calls++;throw new Error('HTTP 412');};
  await c.tick();f.advance(30*60_000);await c.tick();f.advance(120*60_000);await c.tick();
  await c.tick();assert.equal(calls,3);
  assert.equal(f.store.getProgress(c.key).run.status,'done');
  assert.match(f.store.claimDeliveries()[0].payload.reportText,/HTTP 412/);
  f.nextDay();const next=f.make();next.dailyVideos=10;
  f.store.saveProgress(c.key,{queue:[],seen:[],nextPage:1,learned:0,failed:0,total:0,
    run:{day:'2026-11-06',status:'running',items:[],seconds:0,videoLimit:1}});
  await next.tick();assert.equal(f.watched.length,1);assert.equal(next.dailyVideos,10);
});

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'curriculum-'));
  let now = Date.parse('2026-11-05T04:00:00+08:00');
  const store = new VideoLearningStore({ databaseFilePath: path.join(directory, 'db.sqlite'), now: () => now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const watched = [];
  const coordinator = { store, now: () => now, limits: { dailyTasks: 20, dailyMaterialSeconds: 1800, taskMaterialSeconds: 300 },
    async processTask(task) {
      watched.push(task.metadata.preferredBvid);
      store.updateTask(task.taskKey, { status: 'completed', result: { materialSeconds: 30,
        entry: { term: task.topic, meaning: '使用条件与接法', verified: true } } });
    } };
  const make = () => {
    const curriculum = new VideoCurriculum(coordinator, { mid: '123', recipients: ['456'], dailyVideos: 1 });
    curriculum.page = async () => ({ total: 2, videos: [{ bvid: 'BV1aa411c7xx', title: '第一个梗' }, { bvid: 'BV1bb411c7yy', title: '第二个梗' }] });
    return curriculum;
  };
  return { store, watched, coordinator, make, nextDay: () => { now += 86400000; }, advance: ms => { now += ms; } };
}

test('逐个学习，重启同日不重复，次日从队列续学，报告附进度', async t => {
  const f = fixture(t);
  await f.make().tick();
  assert.deepEqual(f.watched, ['BV1aa411c7xx']);
  const [delivery] = f.store.claimDeliveries();
  assert.match(delivery.payload.text, /第一个梗/);
  assert.equal(delivery.payload.reportImage, true);
  assert.equal(delivery.payload.text, '第一个梗\nhttps://www.bilibili.com/video/BV1aa411c7xx');
  assert.equal(delivery.payload.reportItems[0].bvid, 'BV1aa411c7xx');
  assert.match(delivery.payload.reportText, /下次继续：第二个梗/);
  f.store.completeDelivery(delivery.deliveryId, { sent: true });
  await f.make().tick();
  assert.equal(f.watched.length, 1);
  assert.equal(f.store.claimDeliveries().length, 0);
  f.nextDay();
  await f.make().tick();
  assert.deepEqual(f.watched, ['BV1aa411c7xx', 'BV1bb411c7yy']);
  assert.equal(f.store.getProgress('bilibili-space:123').learned, 2);
});

test('分页失败也给报告，保留游标；投递失败有界重试', async t => {
  const f = fixture(t);
  const curriculum = f.make();
  curriculum.page = async () => { throw new Error('B站风控'); };
  await curriculum.tick();
  assert.equal(f.store.getProgress(curriculum.key).nextPage, 1);
  let [delivery] = f.store.claimDeliveries();
  assert.match(delivery.payload.reportText, /B站风控/);
  f.store.completeDelivery(delivery.deliveryId, { sent: false });
  f.advance(61000);
  await curriculum.tick();
  const [retry] = f.store.claimDeliveries();
  assert.equal(retry.deliveryId, delivery.deliveryId);
  assert.equal(f.store.countTasksSince(0), 0, '报告不占学习任务配额');
});

test('进程在视频完成后中断，恢复时只记进度，不重新观看', async t => {
  const f = fixture(t);
  const { task } = f.store.createOrJoinTask({ topic: '第一个梗', metadata: { preferredBvid: 'BV1aa411c7xx' } });
  f.store.updateTask(task.taskKey, { status: 'completed', result: { materialSeconds: 30, entry: { term: '第一个梗', verified: true } } });
  f.store.saveProgress('bilibili-space:123', { queue: [{ bvid: 'BV1aa411c7xx', title: '第一个梗', taskKey: task.taskKey }], seen: [], nextPage: 1, learned: 0, failed: 0, total: 1,
    run: { day: '2026-11-05', status: 'running', items: [], seconds: 0 } });
  await f.make().tick();
  assert.equal(f.watched.length, 0);
  assert.equal(f.store.getProgress('bilibili-space:123').learned, 1);
});

test('预算不足不消费队列，新视频插入页面不重复学已处理BV', async t => {
  const f = fixture(t);
  f.coordinator.limits.dailyMaterialSeconds = 10;
  await f.make().tick();
  assert.equal(f.watched.length, 0);
  assert.equal(f.store.getProgress('bilibili-space:123').queue.length, 2);
  f.coordinator.limits.dailyMaterialSeconds = 1800;
  f.nextDay(); await f.make().tick();
  f.nextDay(); await f.make().tick();
  f.nextDay(); await f.make().tick();
  assert.equal(f.watched.length, 2);
});

test('昨日学习报告按窗口找记录，不被今天凌晨记录覆盖', t => {
  const f = fixture(t);
  f.store.saveCatchupRun('2026-11-04', { day: '2026-11-04', startedAt: 100 });
  f.store.saveCatchupRun('2026-11-05', { day: '2026-11-05', startedAt: 200 });
  assert.equal(f.store.latestCatchupRun(50, 150).day, '2026-11-04');
  assert.equal(f.store.latestCatchupRun(150, 250).day, '2026-11-05');
});

test('中置信候选单独计数，日报说明可接梗但事实待核实', async t => {
  const f = fixture(t);
  f.coordinator.processTask = async task => f.store.updateTask(task.taskKey, {
    status: 'completed', result: { materialSeconds: 30,
      entry: { term: '候选梗', meaning: '梗义候选', confidence: 'medium', verified: false } },
  });
  await f.make().tick();
  const state = f.store.getProgress('bilibili-space:123');
  assert.equal(state.candidate, 1);
  assert.equal(state.failed, 0);
  assert.equal(state.learned, 0);
  const [delivery] = f.store.claimDeliveries();
  assert.equal(delivery.payload.reportItems[0].status, 'candidate');
  assert.match(delivery.payload.reportText, /候选可接梗/);
  assert.match(delivery.payload.reportText, /事实待核实/);
});

test('观看服务繁忙延期不记为失败也不消费每日队列', async t => {
  const f = fixture(t);
  f.coordinator.processTask = async task => f.store.updateTask(task.taskKey, {
    status: 'queued', error: '观看服务忙', metadata: { ...task.metadata, watchRetryAt: f.coordinator.now() + 60000 },
  });
  await f.make().tick();
  const state = f.store.getProgress('bilibili-space:123');
  assert.equal(state.run.items.length, 0);assert.equal(state.queue.length, 2);
  assert.equal(f.store.nextQueuedTask(), null);
  f.advance(60001);assert.ok(f.store.nextQueuedTask());
});
