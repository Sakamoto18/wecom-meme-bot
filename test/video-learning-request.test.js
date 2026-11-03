import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoLearningLinkRequest } from '../src/video-learning-request.js';

const bili = (url = 'https://www.bilibili.com/video/BV1aa411c7xx') => [{ provider: 'bilibili', url }];

test('明确的“学这个视频 + B站链接”才进入指定链接学习', () => {
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

test('普通分享、普通提问和非 B 站链接不劫持媒体流程', () => {
  assert.equal(buildVideoLearningLinkRequest({
    text: '看看这个视频',
    candidates: bili(),
  }), null);
  assert.equal(buildVideoLearningLinkRequest({
    text: '这个视频是什么梗',
    candidates: bili(),
  }), null);
  assert.equal(buildVideoLearningLinkRequest({
    text: '学一下这个视频 https://www.xiaohongshu.com/explore/abc',
    candidates: [{ provider: 'xiaohongshu', url: 'https://www.xiaohongshu.com/explore/abc' }],
  }), null);
});
