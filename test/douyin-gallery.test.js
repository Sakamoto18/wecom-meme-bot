import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDouyinProvider } from '../src/douyin-provider.js';
import { MediaResolver } from '../src/media-resolver.js';
import { QqBotService } from '../src/qq-service.js';

const GALLERY_IMAGES = [
  'https://p3-pc-sign.douyinpic.com/tos-cn-i-0813c000-ce/aaa~tplv-dy-aweme-images:q75.webp?biz_tag=aweme_images',
  'https://p3-pc-sign.douyinpic.com/tos-cn-i-0813c000-ce/bbb~tplv-dy-aweme-images:q75.webp?biz_tag=aweme_images',
  'https://p9-pc-sign.douyinpic.com/tos-cn-i-0813c000-ce/ccc~tplv-dy-aweme-images:q75.webp?biz_tag=aweme_images',
];

function galleryPayload(overrides = {}) {
  return { status: 'success', data: {
    type_verified: true, source_id: '123456789', media_type: 'images', video_url: '', images: GALLERY_IMAGES,
    cover: GALLERY_IMAGES[0], title: '图文标题 - 抖音', description: '图文正文',
    author: '图文作者', avatar_url: 'https://cdn.example/avatar.jpg', tags: ['话题'],
    ...overrides,
  } };
}

test('抖音图文经全链路产出 media-gallery，和小红书图集同一种输出', async (t) => {
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'douyin-gallery-'));
  let providerCalls = 0;
  t.mock.method(globalThis, 'fetch', async (endpoint, options) => {
    providerCalls++;
    assert.equal(endpoint, 'http://provider.test/resolve');
    assert.deepEqual(JSON.parse(options.body), { url: 'https://v.douyin.com/note-example/' });
    return new Response(JSON.stringify(galleryPayload()));
  });
  const resolver = new MediaResolver({ enabled: true, cacheDirectory,
    command: 'must-not-run-yt-dlp',
    publicBaseUrl: 'http://qq-bot:8787',
    providerResolver: createDouyinProvider({ providerUrl: 'http://provider.test/resolve' }),
  });
  const service = new QqBotService({ mediaResolver: resolver, logger: { info() {}, warn() {} } });
  try {
    const result = await service.handleMessage({ group_id: '499615970', user_id: 'tester',
      text: 'https://v.douyin.com/note-example/', media_share: true });
    assert.equal(result.mode, 'media-gallery');
    const message = result.messages[0];
    assert.equal(message.type, 'forward');
    assert.deepEqual(message.images, GALLERY_IMAGES);
    assert.equal(message.provider, 'douyin');
    assert.equal(message.author, '图文作者');
    assert.equal(message.avatarUrl, 'https://cdn.example/avatar.jpg');
    assert.equal(message.coverUrl, GALLERY_IMAGES[0]);
    assert.equal(message.title, '图文标题 - 抖音');
    // 图集不能带视频地址：带了就会被当成单条视频发出去。
    assert.equal(message.url, undefined);
    assert.equal(providerCalls, 1);
  } finally {
    resolver.close();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

test('图集兜底标题按平台走，抖音图文不会顶着小红书的名字', async (t) => {
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'douyin-gallery-title-'));
  t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify(galleryPayload({ title: '' })),
  ));
  const resolver = new MediaResolver({ enabled: true, cacheDirectory,
    command: 'must-not-run-yt-dlp', publicBaseUrl: 'http://qq-bot:8787',
    providerResolver: createDouyinProvider({ providerUrl: 'http://provider.test/resolve' }),
  });
  const service = new QqBotService({ mediaResolver: resolver, logger: { info() {}, warn() {} } });
  try {
    const result = await service.handleMessage({ group_id: '499615970', user_id: 'tester',
      text: 'https://v.douyin.com/note-example/', media_share: true });
    assert.equal(result.messages[0].title, '抖音图文');
  } finally {
    resolver.close();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

test('抖音 Provider 的图文与视频互斥，且图集去重限长', async (t) => {
  let data = {};
  t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify({ status: 'success', data }),
  ));
  const provider = createDouyinProvider({ providerUrl: 'http://provider.test/resolve' });

  // 图文：拿到 images，绝不返回 mediaUrl。
  data = galleryPayload().data;
  let resolved = await provider({ platform: 'douyin', url: 'https://v.douyin.com/n/' });
  assert.equal(resolved.mediaUrl, '');
  assert.deepEqual(resolved.images, GALLERY_IMAGES);
  assert.equal(resolved.description, '图文正文');

  // 视频：images 必须为空，否则会被当图集发。
  data = { type_verified: true, source_id: '123456789', media_type: 'video', video_url: 'https://cdn.example/v.mp4',
    cover: 'https://cdn.example/c.jpg', images: GALLERY_IMAGES, title: 't' };
  resolved = await provider({ platform: 'douyin', url: 'https://v.douyin.com/v/' });
  assert.equal(resolved.mediaUrl, 'https://cdn.example/v.mp4');
  assert.deepEqual(resolved.images, []);

  // 图文页一张图都没提取到时不能假装成功。
  data = { type_verified: true, source_id: '123456789', media_type: 'images', video_url: '', images: [] };
  await assert.rejects(
    provider({ platform: 'douyin', url: 'https://v.douyin.com/n/' }),
    /未返回当前作品的可用资源|作品类型未确认/,
  );

  // 重复地址去重，超过 18 张截断。
  const many = Array.from({ length: 25 }, (_, i) => `https://p3.douyinpic.com/x${i}~tplv-dy-aweme-images:q75.webp`);
  data = { type_verified: true, source_id: '123456789', media_type: 'images', video_url: '', images: [...many, many[0], many[1]] };
  resolved = await provider({ platform: 'douyin', url: 'https://v.douyin.com/n/' });
  assert.equal(resolved.images.length, 18);
  assert.equal(new Set(resolved.images).size, 18);

  // 图文没给 cover 时用第一张图兜底，卡片才有图。
  data = { type_verified: true, source_id: '123456789', media_type: 'images', video_url: '', images: GALLERY_IMAGES, cover: '' };
  resolved = await provider({ platform: 'douyin', url: 'https://v.douyin.com/n/' });
  assert.equal(resolved.coverUrl, GALLERY_IMAGES[0]);
});

test('抖音多视频分享保留每条视频和封面', async (t) => {
  const videos = [
    { video_url: 'https://cdn.example/video-1.mp4', cover: 'https://cdn.example/cover-1.jpg', duration: 3 },
    { video_url: 'https://cdn.example/video-2.mp4', cover: 'https://cdn.example/cover-2.jpg', duration: 5 },
  ];
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ status: 'success', data: {
    type_verified: true, source_id: '123456789', media_type: 'videos', videos, title: '双视频', author: '原作者',
  } })));
  const provider = createDouyinProvider({ providerUrl: 'http://provider.test/resolve' });
  const resolved = await provider({ platform: 'douyin', url: 'https://v.douyin.com/multi/' });
  assert.equal(resolved.mediaUrl, '');
  assert.equal(resolved.mediaItems.length, 2);
  assert.deepEqual(resolved.images, videos.map((item) => item.cover));
  assert.deepEqual(resolved.mediaItems.map((item) => item.mediaUrl), videos.map((item) => item.video_url));
  assert.deepEqual(resolved.mediaItems.map((item) => item.coverUrl), videos.map((item) => item.cover));
});

test('抖音图文的动态 MP4 资源作为可选动图元数据保留，不改变图文类型', async (t) => {
  const animated = [
    { video_url: 'https://cdn.example/animated-1.mp4', cover: GALLERY_IMAGES[0] },
    { video_url: 'https://cdn.example/animated-2.mp4', cover: GALLERY_IMAGES[1] },
  ];
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ status: 'success', data: {
    type_verified: true, source_id: '123456789', media_type: 'images', images: GALLERY_IMAGES, animated_videos: animated,
  } })));
  const provider = createDouyinProvider({ providerUrl: 'http://provider.test/resolve' });
  const resolved = await provider({ platform: 'douyin', url: 'https://v.douyin.com/note/' });
  assert.equal(resolved.mediaUrl, '');
  assert.deepEqual(resolved.images, GALLERY_IMAGES);
  assert.deepEqual(resolved.animatedItems.map((item) => item.mediaUrl), animated.map((item) => item.video_url));
});

test('抖音图文动效转成 GIF URL，失败时才回退静态图', async () => {
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'douyin-animated-gallery-'));
  const fakeFfmpeg = path.join(cacheDirectory, 'fake-ffmpeg');
  await writeFile(fakeFfmpeg, '#!/usr/bin/env node\n\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.argv.at(-1), "GIF89a");\n');
  await chmod(fakeFfmpeg, 0o755);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (endpoint, options = {}) => {
    if (String(endpoint) === 'http://provider.test/resolve') {
      return new Response(JSON.stringify(galleryPayload({
        images: GALLERY_IMAGES.slice(0, 2),
        animated_videos: [
          { video_url: 'https://cdn.example/animated-1.mp4', size: 5 },
          { video_url: 'https://cdn.example/animated-2.mp4', size: 5 },
        ],
      })), { headers: { 'content-type': 'application/json' } });
    }
    if (String(endpoint).includes('animated-')) {
      return new Response(Buffer.from('not-a-real-mp4'), {
        headers: { 'content-length': '14' },
      });
    }
    throw new Error(`unexpected fetch ${String(endpoint)} ${JSON.stringify(options)}`);
  };
  const resolver = new MediaResolver({ enabled: true, cacheDirectory,
    cacheTtlMs: 60_000, ffmpegCommand: fakeFfmpeg,
    publicBaseUrl: 'http://qq-bot:8787',
    providerResolver: createDouyinProvider({ providerUrl: 'http://provider.test/resolve' }),
    logger: { info() {}, warn() {} },
  });
  try {
    const result = await resolver.resolve({ url: 'https://v.douyin.com/animated-note/', provider: 'douyin' });
    assert.equal(result.images.length, 2);
    assert.ok(result.images.every((url) => url.startsWith('http://qq-bot:8787/v1/qq/media/')));
    const mediaIds = result.images.map((url) => url.split('/').pop());
    const resources = await Promise.all(mediaIds.map((id) => resolver.getMediaFile(id)));
    assert.deepEqual(resources.map((item) => item.mediaType), ['image/gif', 'image/gif']);
    assert.deepEqual(resources.map((item) => item.size), [6, 6]);
  } finally {
    resolver.close();
    globalThis.fetch = originalFetch;
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

test('图文与视频交替分享，冷缓存和热缓存均按各自作品输出', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-order-'));
  const counts = new Map();
  t.mock.method(globalThis, 'fetch', async (endpoint, options = {}) => {
    if (endpoint === 'https://cdn.example/video.mp4') return new Response('video');
    const { url } = JSON.parse(options.body);
    counts.set(url, (counts.get(url) || 0) + 1);
    const isGallery = url.endsWith('/gallery/');
    return new Response(JSON.stringify({ status: 'success', data: isGallery
      ? galleryPayload({
        source_id: '100',
        // A stray player must not leak into the gallery branch.
        videos: [{ video_url: 'https://cdn.example/stray-1.mp4' },
          { video_url: 'https://cdn.example/stray-2.mp4' }],
      }).data
      : { type_verified: true, source_id: '200', media_type: 'video',
        video_url: 'https://cdn.example/video.mp4', size: 5, images: GALLERY_IMAGES },
    }));
  });
  const resolver = new MediaResolver({ enabled: true, cacheDirectory: dir,
    publicBaseUrl: 'http://qq-bot:8787', command: 'must-not-run',
    providerResolver: createDouyinProvider({ providerUrl: 'http://provider.test/resolve' }),
    logger: { info() {}, warn() {} },
  });
  const service = new QqBotService({ mediaResolver: resolver, logger: { info() {}, warn() {} } });
  try {
    for (const order of [['gallery', 'video', 'gallery', 'video'], ['video', 'gallery', 'video', 'gallery']]) {
      resolver.cache.clear(); counts.clear();
      for (const kind of order) {
        const result = await service.handleMessage({ group_id: 'test', user_id: 'tester',
          text: `https://v.douyin.com/${kind}/`, media_share: true });
        assert.equal(result.mode, kind === 'gallery' ? 'media-gallery' : 'media');
        assert.equal(result.messages[0].type, kind === 'gallery' ? 'forward' : 'video');
        if (kind === 'gallery') assert.deepEqual(result.messages[0].images, GALLERY_IMAGES);
        else assert.deepEqual(result.messages[0].images, []);
      }
      assert.deepEqual([...counts.values()], [1, 1]);
    }
  } finally { resolver.close(); await rm(dir, { recursive: true, force: true }); }
});

test('未确认类型或作品 ID 不匹配时不降级、不缓存，后续重试可恢复', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-unknown-'));
  let payload = { status: 'failed', msg: 'work_metadata_unavailable' };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (endpoint) => {
    assert.equal(endpoint, 'http://provider.test/resolve', '不应降级读取公开页或视频');
    calls++;
    return new Response(JSON.stringify(payload));
  });
  const resolver = new MediaResolver({ enabled: true, cacheDirectory: dir,
    publicBaseUrl: 'http://qq-bot:8787', command: 'must-not-run',
    providerResolver: createDouyinProvider({ providerUrl: 'http://provider.test/resolve' }),
    logger: { info() {}, warn() {} },
  });
  const candidate = { url: 'https://www.douyin.com/note/100', provider: 'douyin' };
  try {
    await assert.rejects(resolver.resolve(candidate), /work_metadata_unavailable/);
    assert.equal(resolver.cache.size, 0);
    assert.equal(resolver.inflight.size, 0);
    payload = galleryPayload({ source_id: '200' });
    await assert.rejects(resolver.resolve(candidate), /作品类型未确认/);
    assert.equal(resolver.cache.size, 0);
    payload = galleryPayload({ source_id: '100' });
    const result = await resolver.resolve(candidate);
    assert.equal(result.contentKind, 'gallery');
    assert.equal(result.sourceId, '100');
    await resolver.resolve(candidate);
    assert.equal(calls, 3);
  } finally { resolver.close(); await rm(dir, { recursive: true, force: true }); }
});

test('混合图文只替换对应动图位置，静态图保留', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-mixed-'));
  const fakeFfmpeg = path.join(dir, 'fake-ffmpeg');
  await writeFile(fakeFfmpeg, '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.argv.at(-1), "GIF89a");\n');
  await chmod(fakeFfmpeg, 0o755);
  t.mock.method(globalThis, 'fetch', async () => new Response('mp4', { headers: { 'content-length': '3' } }));
  const resolver = new MediaResolver({ enabled: true, cacheDirectory: dir, ffmpegCommand: fakeFfmpeg,
    publicBaseUrl: 'http://qq-bot:8787', logger: { info() {}, warn() {} },
  });
  try {
    const result = await resolver.prepareAnimatedGalleryImages({ animatedItems: [
      { imageIndex: 1, mediaUrl: 'https://cdn.example/live.mp4', size: 3 },
    ] }, GALLERY_IMAGES, 1000);
    assert.equal(result[0], GALLERY_IMAGES[0]);
    assert.equal(result[2], GALLERY_IMAGES[2]);
    const resource = await resolver.getMediaFile(result[1].split('/').pop());
    assert.equal(resource.mediaType, 'image/gif');
  } finally { resolver.close(); await rm(dir, { recursive: true, force: true }); }
});
