import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSharedUrl } from '../src/share-resolver.js';

test('通用分享解析器跟随跳转并提取公开视频元数据', async () => {
  const result = await resolveSharedUrl('https://share.example/s/demo', {
    fetchImpl: async () => new Response(
      '<meta property="og:title" content="Demo"><meta property="og:image" content="https://cdn.example/cover.jpg"><meta property="og:video" content="https://cdn.example/video.mp4">',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ),
  });
  assert.equal(result.title, 'Demo');
  assert.equal(result.canonicalUrl, 'https://share.example/s/demo');
  assert.equal(result.mediaUrl, 'https://cdn.example/video.mp4');
});
