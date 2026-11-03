import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VideoLearningStore } from '../src/video-learning-store.js';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'video-learning-store-'));
  const store = new VideoLearningStore({
    databaseFilePath: path.join(directory, 'learning.sqlite'),
    now: () => 1_700_000_000_000,
  });
  return { directory, store };
}

test('学习任务按主题合并并可持久化状态', () => {
  const { directory, store } = fixture();
  try {
    const first = store.createOrJoinTask({ topic: '尊嘟假嘟', question: '这是什么梗？' });
    const second = store.createOrJoinTask({ topic: '尊嘟假嘟', question: '怎么用？' });
    assert.equal(first.joined, false);
    assert.equal(second.joined, true);
    assert.equal(second.task.taskKey, first.task.taskKey);
    assert.equal(store.updateTask(first.task.taskKey, { status: 'watching' }).status, 'watching');
    assert.equal(store.findActiveTask('尊嘟假嘟').status, 'watching');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('提醒和结果投递可领取、租约恢复并完成', () => {
  const { directory, store } = fixture();
  try {
    const { task } = store.createOrJoinTask({ topic: '测试梗' });
    const reminder = store.enqueueDelivery(task.taskKey, 'reminder', { text: '我去查一下' });
    assert.equal(store.enqueueDelivery(task.taskKey, 'reminder').deliveryId, reminder.deliveryId);
    const claimed = store.claimDeliveries(5, 1_000);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].status, 'leased');
    assert.equal(store.completeDelivery(reminder.deliveryId).status, 'sent');
    assert.equal(store.getStats().pendingDeliveries, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('视频来源按 BV/CID/分 P 去重并记录时间轴观察', () => {
  const { directory, store } = fixture();
  try {
    const { task } = store.createOrJoinTask({ topic: '视频梗' });
    const source = store.rememberSource({ bvid: 'BV1TEST', cid: '99', page: 1, title: '示例' });
    const same = store.rememberSource({ sourceKey: source.sourceKey, bvid: 'BV1TEST', cid: '99', page: 1, title: '更新标题' });
    assert.equal(same.sourceKey, source.sourceKey);
    assert.equal(same.title, '更新标题');
    const observation = store.addObservation({
      taskKey: task.taskKey,
      sourceKey: source.sourceKey,
      startSeconds: 12,
      endSeconds: 18,
      evidence: { frames: [{ at: 14, path: 'frame.png' }], transcript: '示例' },
    });
    assert.equal(observation.startSeconds, 12);
    assert.equal(store.getStats().observations, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
