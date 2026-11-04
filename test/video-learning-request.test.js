import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoLearningLinkRequest } from '../src/video-learning-request.js';

const bili = (url = 'https://www.bilibili.com/video/BV1aa411c7xx') => [{ provider: 'bilibili', url }];

test('B站链接 + 用户的话会生成候选，并规范成标准视频地址', () => {
  assert.deepEqual(buildVideoLearningLinkRequest({
    text: '学一下这个视频 https://www.bilibili.com/video/BV1aa411c7xx',
    candidates: bili(),
  }), {
    directLink: true,
    preferredUrl: 'https://www.bilibili.com/video/BV1aa411c7xx',
    preferredBvid: 'BV1aa411c7xx',
  });
  assert.equal(buildVideoLearningLinkRequest({
    text: '这个视频里的梗学一下',
    candidates: bili('https://b23.tv/AbCdEfG'),
  }).preferredBvid, '');
  assert.equal(buildVideoLearningLinkRequest({
    text: '分析一下这个视频',
    candidates: bili(),
  }).preferredBvid, 'BV1aa411c7xx');
  assert.deepEqual(buildVideoLearningLinkRequest({
    text: 'https://www.bilibili.com/video/BV1hznR6oETN@龙2号机 学习一下这个视频',
    candidates: bili('https://www.bilibili.com/video/BV1hznR6oETN@%E9%BE%992%E5%8F%B7%E6%9C%BA'),
  }), {
    directLink: true,
    preferredUrl: 'https://www.bilibili.com/video/BV1hznR6oETN',
    preferredBvid: 'BV1hznR6oETN',
  });
});

test('只有链接和分享标题的普通分享不算候选；带任何话的都交给模型判断', () => {
  assert.equal(buildVideoLearningLinkRequest({
    text: '【TES先锋赛单曲1.0《突然的陀螺》】 https://www.bilibili.com/video/BV1aa411c7xx',
    candidates: bili(),
  }), null);
  assert.equal(buildVideoLearningLinkRequest({ text: '', candidates: bili() }), null);
  for (const text of ['看看这个视频', '学习一下，全文背诵', '背下来']) {
    assert.equal(buildVideoLearningLinkRequest({ text, candidates: bili() }).preferredBvid, 'BV1aa411c7xx', text);
  }
  assert.equal(buildVideoLearningLinkRequest({
    text: '学一下这个视频 https://www.xiaohongshu.com/explore/abc',
    candidates: [{ provider: 'xiaohongshu', url: 'https://www.xiaohongshu.com/explore/abc' }],
  }), null);
});
