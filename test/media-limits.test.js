import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaResolver } from '../src/media-resolver.js';
import { QqBotService } from '../src/qq-service.js';
import {
  MAX_MEDIA_BYTES, MAX_MEDIA_EXTRACTION_MS, isMediaTooLargeError,
  mediaExtractionTimeoutError,
} from '../src/media-limits.js';

test('视频大小上限为 500 MiB，已知超大 Provider 结果在下载前拒绝', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'media-limit-'));
  const resolver = new MediaResolver({ enabled: true, cacheDirectory: directory });
  try {
    await assert.rejects(
      resolver.rejectIfTooLarge({ size: MAX_MEDIA_BYTES + 1 }),
      (error) => isMediaTooLargeError(error),
    );
  } finally {
    resolver.close();
  }
});

test('解析超时时间硬上限为 8 分钟，避免配置把并发槽永久占住', () => {
  const resolver = new MediaResolver({ enabled: true, timeoutMs: 30 * 60 * 1000 });
  try {
    assert.equal(resolver.timeoutMs, MAX_MEDIA_EXTRACTION_MS);
  } finally {
    resolver.close();
  }
});

test('视频自身时长不作为拦截条件', () => {
  const resolver = new MediaResolver({ enabled: true });
  try {
    const result = resolver.registerRemoteMedia({
      mediaUrl: 'https://cdn.example/hour.mp4',
      size: 1234,
      duration: 60 * 60,
    });
    assert.equal(result.duration, 60 * 60);
  } finally { resolver.close(); }
});

test('QQ 对超大视频返回可见提示，而不是占用发送并发', async () => {
  const resolver = new MediaResolver({
    enabled: true,
    providerResolver: async () => ({
      mediaUrl: 'https://cdn.example/huge.mp4', size: MAX_MEDIA_BYTES + 1,
    }),
  });
  try {
    const service = new QqBotService({ mediaResolver: resolver });
    const result = await service.handleMessage({
      group_id: '1109147947', user_id: 'tester',
      text: 'https://v.douyin.com/huge/', media_share: true,
    });
    assert.equal(result.mode, 'media-unavailable');
    assert.equal(result.messages[0].text, '这个视频超过 500MB，建议点击分享前往平台观看。');
  } finally { resolver.close(); }
});

test('QQ 对超过 8 分钟的提取返回超时提示', async () => {
  const resolver = new MediaResolver({
    enabled: true,
    providerResolver: async () => { throw mediaExtractionTimeoutError(); },
  });
  try {
    const service = new QqBotService({ mediaResolver: resolver });
    const result = await service.handleMessage({
      group_id: '1109147947', user_id: 'tester',
      text: 'https://v.douyin.com/timeout/', media_share: true,
    });
    assert.equal(result.mode, 'media-unavailable');
    assert.equal(result.messages[0].text, '视频提取超过 8 分钟，已中断，建议点击分享前往平台观看。');
  } finally { resolver.close(); }
});
