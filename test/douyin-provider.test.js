import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDouyinProvider } from '../src/douyin-provider.js';
import { MediaResolver } from '../src/media-resolver.js';
import { QqBotService } from '../src/qq-service.js';

test('抖音 HTTP 响应经 Provider 和媒体解析器生成代理视频，跨群复用且不直连 CDN', async (t) => {
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'douyin-contract-'));
  let calls = 0;
  let providerCalls = 0;
  t.mock.method(globalThis, 'fetch', async (endpoint, options) => {
    calls++;
    if (endpoint === 'https://cdn.example/work.mp4') {
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0, 1, 2])); controller.close(); } }), {
        status: 200, headers: { 'content-length': '3' },
      });
    }
    providerCalls++;
    assert.equal(endpoint, 'http://provider.test/resolve');
    assert.deepEqual(JSON.parse(options.body), { url: 'https://v.douyin.com/example/' });
    return new Response(JSON.stringify({ status: 'success', data: {
      media_type: 'video', video_url: 'https://cdn.example/work.mp4',
      size: 1234,
      cover: 'https://cdn.example/cover.jpg', title: '作品标题', description: '作品正文',
      author: '原作者', avatar_url: 'https://cdn.example/avatar.jpg', tags: ['话题'],
    } }));
  });
  const resolver = new MediaResolver({ enabled: true, cacheDirectory,
    command: 'must-not-run-yt-dlp',
    publicBaseUrl: 'http://qq-bot:8787',
    providerResolver: createDouyinProvider({ providerUrl: 'http://provider.test/resolve' }),
  });
  const service = new QqBotService({ mediaResolver: resolver, logger: { info() {}, warn() {} } });
  try {
    for (const group_id of ['1109147947', '499615970']) {
      const result = await service.handleMessage({ group_id, user_id: 'tester',
        text: 'https://v.douyin.com/example/', media_share: true });
      assert.equal(result.mode, 'media');
      assert.equal(result.messages[0].type, 'video');
      assert.match(result.messages[0].url, /^http:\/\/qq-bot:8787\/v1\/qq\/media\//u);
      assert.equal(result.messages[0].coverUrl, 'https://cdn.example/cover.jpg');
      assert.equal(result.messages[0].author, '原作者');
      assert.equal(result.messages[0].avatarUrl, 'https://cdn.example/avatar.jpg');
      assert.equal(result.messages[0].provider, 'douyin');
    }
    assert.equal(providerCalls, 1);
    assert.ok(calls >= 2);
  } finally {
    resolver.close();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

test('抖音 Provider 拒绝假成功/占位文件，非抖音链接不会请求接口', async (t) => {
  let calls = 0;
  let data = {};
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(JSON.stringify({ status: 'success', data }));
  });
  const provider = createDouyinProvider({ providerUrl: 'http://provider.test/resolve' });
  assert.equal(await provider({ platform: 'bilibili' }), null);
  assert.equal(calls, 0);
  await assert.rejects(provider({ platform: 'douyin', url: 'https://v.douyin.com/example/' }), /未返回可用视频地址/);
  data = { video_url: 'https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/uuu_265.mp4' };
  await assert.rejects(provider({ platform: 'douyin' }), /占位视频/);
});
