import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaResolver, normalizeDownloadSource } from '../src/media-resolver.js';
import { extractBilibiliVideoId, resolveBilibiliMedia } from '../src/bilibili-provider.js';

test('B站 QQ 小程序播放器地址转换为 yt-dlp 支持的视频页', () => {
  assert.equal(
    normalizeDownloadSource('https://player.bilibili.com/player.html?bvid=BV1DV5v6HELu'),
    'https://www.bilibili.com/video/BV1DV5v6HELu',
  );
  assert.equal(
    normalizeDownloadSource('https://player.bilibili.com/player.html?aid=123456'),
    'https://www.bilibili.com/video/av123456',
  );
});

test('B站卡片编码参数中的 BV 号也能提取', () => {
  assert.deepEqual(
    extractBilibiliVideoId('https://example.com/jump?target=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1DV5v6HELu'),
    { bvid: 'BV1DV5v6HELu' },
  );
});

test('B站公开接口按 bvid 获取 cid 和 MP4 流', async () => {
  const requested = [];
  const result = await resolveBilibiliMedia(
    'https://player.bilibili.com/player.html?bvid=BV1DV5v6HELu',
    {
      fetchImpl: async (url) => {
        requested.push(String(url));
        if (String(url).includes('/view?')) {
          return new Response(JSON.stringify({ code: 0, data: { cid: 99, title: '测试', duration: 12 } }));
        }
        return new Response(JSON.stringify({
          code: 0, data: { durl: [{ size: 100, url: 'https://cdn.example/video.mp4' }] },
        }));
      },
    },
  );
  assert.deepEqual(extractBilibiliVideoId('https://www.bilibili.com/video/BV1DV5v6HELu'), { bvid: 'BV1DV5v6HELu' });
  assert.equal(requested.length, 2);
  assert.match(requested[1], /cid=99/u);
  assert.equal(result.mediaUrl, 'https://cdn.example/video.mp4');
  assert.equal(result.title, '测试');
  assert.equal(result.size, 100);
});

test('B站单文件 MP4 注册为流式中转，不等待完整下载', async () => {
  const resolver = new MediaResolver({ enabled: true, cacheTtlMs: 60_000 });
  const result = resolver.registerRemoteMedia({
    mediaUrl: 'https://cdn.example/video.mp4', size: 1234, title: '流式视频',
    requestHeaders: { referer: 'https://www.bilibili.com/' },
  });
  const resource = await resolver.getMediaFile(result.mediaId);
  assert.equal(result.streamed, true);
  assert.equal(result.downloadBytes, 0);
  assert.equal(resource.remote, true);
  assert.equal(resource.remoteUrl, 'https://cdn.example/video.mp4');
  resolver.close();
});

test('媒体主链优先使用 Provider 直链且不下载文件', async () => {
  const calls = [];
  const resolver = new MediaResolver({
    enabled: true,
    providerResolver: async (input) => {
      calls.push(input);
      return { mediaUrl: 'https://cdn.example/high.mp4', title: '最高画质' };
    },
    cacheTtlMs: 0,
  });
  const result = await resolver.resolve({
    url: 'https://xhslink.com/demo',
    provider: 'xiaohongshu',
  });
  assert.deepEqual(calls, [{
    url: 'https://xhslink.com/demo',
    platform: 'xiaohongshu',
  }]);
  assert.equal(result.url, 'https://cdn.example/high.mp4');
  assert.equal(result.extractor, 'provider-direct');
  assert.equal(result.downloadBytes, 0);
  assert.equal(result.outputBytes, 0);
  assert.equal(result.direct, true);
});
