import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { handleXhsLink } from '../src/bot/listeners/xhsListener.js';

function childWithJson(value, code = 0) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null);
  queueMicrotask(() => {
    child.stdout.end(JSON.stringify(value));
    child.emit('close', code);
  });
  return child;
}

test('XHS listener 提取链接并发送解析出的直链文本', async () => {
  const sent = [];
  const result = await handleXhsLink({
    group_id: 'g1',
    raw_message: '分享 https://xhslink.com/aBc123 看看',
  }, {
    spawnImpl: () => childWithJson({
      status: 'success',
      data: { video_url: 'https://cdn.example/video.mp4' },
    }),
    send: async (groupId, text) => sent.push({ groupId, text }),
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(sent, [{ groupId: 'g1', text: '🎬 视频直链：https://cdn.example/video.mp4' }]);
});

test('XHS listener 透传解析脚本失败信息', async () => {
  const sent = [];
  await handleXhsLink({
    group_id: 'g1',
    raw_message: 'https://www.xiaohongshu.com/discovery/item/demo123',
  }, {
    spawnImpl: () => childWithJson({ status: 'failed', msg: '未配置已授权的详情接口' }),
    send: async (_groupId, text) => sent.push(text),
  });
  assert.deepEqual(sent, ['未配置已授权的详情接口']);
});

test('XHS listener 超时后终止子进程并返回重试提示', async () => {
  const sent = [];
  let killed = false;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { killed = true; };
  const result = await handleXhsLink({
    group_id: 'g1',
    raw_message: 'https://xhslink.com/timeout',
  }, {
    timeoutMs: 5,
    spawnImpl: () => child,
    send: async (_groupId, text) => sent.push(text),
  });
  assert.equal(result.status, 'timeout');
  assert.equal(killed, true);
  assert.deepEqual(sent, ['解析超时，请稍后重试']);
});
