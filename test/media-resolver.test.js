import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaResolver, normalizeDownloadSource } from '../src/media-resolver.js';
import {
  extractBilibiliVideoId, extractBilibiliVideoIdFromToolOutput, resolveBilibiliMedia,
} from '../src/bilibili-provider.js';

test('并发名额直接交给队首，新请求不能抢走刚释放的名额', async () => {
  const resolver = new MediaResolver({ maxConcurrent: 1 });
  try {
    await resolver.acquireSlot();
    const second = resolver.acquireSlot();
    resolver.releaseSlot();
    let thirdStarted = false;
    const third = resolver.acquireSlot().then(() => { thirdStarted = true; });
    await second;
    assert.equal(thirdStarted, false);
    assert.equal(resolver.active, 1);
    resolver.releaseSlot();
    await third;
    assert.equal(resolver.active, 1);
    resolver.releaseSlot();
    assert.equal(resolver.active, 0);
  } finally { resolver.close(); }
});

test('三个群不同链接有界并发，同链接合并，已有缓存不等抓取名额', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'media-concurrent-'));
  const gates = new Map(['one', 'two', 'three'].map(key => [key, Promise.withResolvers()]));
  const entered = new Map(['one', 'two', 'three'].map(key => [key, Promise.withResolvers()]));
  const calls = [];
  const resolver = new MediaResolver({ enabled: true, maxConcurrent: 2, cacheDirectory: directory,
    providerResolver: async ({ url }) => {
      const key = new URL(url).pathname.slice(1);
      calls.push(key);
      entered.get(key)?.resolve();
      if (gates.has(key)) await gates.get(key).promise;
      return { images: [`https://cdn.example/${key}.jpg`], title: key };
    },
  });
  const candidate = key => ({ provider: 'xiaohongshu', url: `https://xhslink.com/${key}` });
  const pending = [];
  try {
    const cached = await resolver.resolve(candidate('cached'));
    pending.push(resolver.resolve(candidate('one')), resolver.resolve(candidate('two')));
    await Promise.all([entered.get('one').promise, entered.get('two').promise]);
    pending.push(resolver.resolve(candidate('three')), resolver.resolve(candidate('one')));
    assert.strictEqual(await resolver.resolve(candidate('cached')), cached);
    assert.deepEqual([...calls].sort(), ['cached', 'one', 'two']);
    gates.get('one').resolve();
    await entered.get('three').promise;
    assert.equal(resolver.active, 2);
    gates.get('two').resolve();
    gates.get('three').resolve();
    const results = await Promise.all(pending);
    assert.deepEqual(results.map(r => r.title), ['one', 'two', 'three', 'one']);
    assert.strictEqual(results[0], results[3]);
    assert.deepEqual([...calls].sort(), ['cached', 'one', 'three', 'two']);
    assert.equal(resolver.active, 0);
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await Promise.allSettled(pending);
    resolver.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('三个群共用一次失败解析后，下次分享重新抓取，不缓存失败', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'media-retry-'));
  const finish = Promise.withResolvers();
  let calls = 0;
  const resolver = new MediaResolver({ enabled: true, cacheDirectory: directory,
    providerResolver: async () => {
      calls++;
      await finish.promise;
      if (calls === 1) throw new Error('provider timeout');
      return { sourceId: '123', contentKind: 'gallery', images: ['https://cdn.example/ok.jpg'] };
    },
  });
  try {
    const candidate = { url: 'https://www.douyin.com/note/123', provider: 'douyin' };
    // Let all three callers join the first task before simulating its failure.
    const originalCleanup = resolver.cleanupExpired.bind(resolver);
    const joined = Promise.withResolvers();
    let arrivals = 0;
    resolver.cleanupExpired = async () => { await originalCleanup(); if (++arrivals === 3) joined.resolve(); };
    const pending = Promise.allSettled([1, 2, 3].map(() => resolver.resolve(candidate)));
    await joined.promise;
    await new Promise(resolve => setImmediate(resolve));
    finish.resolve();
    assert.ok((await pending).every(r => r.status === 'rejected'));
    assert.equal(calls, 1);
    assert.equal(resolver.inflight.size, 0);
    assert.equal(resolver.cache.size, 0);
    assert.equal((await resolver.resolve(candidate)).images.length, 1);
    assert.equal(calls, 2);
  } finally {
    finish.resolve();
    resolver.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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

test('从 yt-dlp 的 412 错误输出回收 B站 BV 号', () => {
  assert.deepEqual(
    extractBilibiliVideoIdFromToolOutput('[BiliBili] 18U4R6GEkz: Downloading webpage\nHTTP Error 412'),
    { bvid: 'BV18U4R6GEkz' },
  );
});

test('B站短链跳转 412 时使用工具回收的 BV 号访问公开接口', async () => {
  const requested = [];
  const result = await resolveBilibiliMedia('https://b23.tv/BQHUcP1', {
    shortLinkIdResolver: async () => ({ bvid: 'BV18U4R6GEkz' }),
    fetchImpl: async (url) => {
      requested.push(String(url));
      if (String(url).startsWith('https://b23.tv/')) return new Response('', { status: 412 });
      if (String(url).includes('/view?')) {
        return new Response(JSON.stringify({ code: 0, data: { cid: 88, title: '短链测试' } }));
      }
      return new Response(JSON.stringify({
        code: 0, data: { durl: [{ size: 9, url: 'https://cdn.example/short.mp4' }] },
      }));
    },
  });
  assert.match(requested[1], /bvid=BV18U4R6GEkz/u);
  assert.equal(result.mediaUrl, 'https://cdn.example/short.mp4');
});

test('B站短链只读取第一跳 Location，避免跟随到网页触发 412', async () => {
  const requested = [];
  const result = await resolveBilibiliMedia('https://b23.tv/BQHUcP1', {
    fetchImpl: async (url, options = {}) => {
      requested.push({ url: String(url), redirect: options.redirect });
      if (String(url).startsWith('https://b23.tv/')) {
        return new Response('', {
          status: 302, headers: { location: 'https://www.bilibili.com/video/BV18U4R6GEkz?p=1' },
        });
      }
      if (String(url).includes('/view?')) {
        return new Response(JSON.stringify({ code: 0, data: { cid: 88, title: '第一跳测试' } }));
      }
      return new Response(JSON.stringify({
        code: 0, data: { durl: [{ size: 9, url: 'https://cdn.example/manual.mp4' }] },
      }));
    },
  });
  assert.equal(requested[0].redirect, 'manual');
  assert.match(requested[1].url, /bvid=BV18U4R6GEkz/u);
  assert.equal(result.mediaUrl, 'https://cdn.example/manual.mp4');
});

test('B站公开接口按 bvid 获取 cid 和 MP4 流', async () => {
  const requested = [];
  const result = await resolveBilibiliMedia(
    'https://player.bilibili.com/player.html?bvid=BV1DV5v6HELu',
    {
      fetchImpl: async (url) => {
        requested.push(String(url));
        if (String(url).includes('/view?')) {
          return new Response(JSON.stringify({ code: 0, data: { cid: 99, title: '测试', duration: 12, pubdate: 1789113600 } }));
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
  assert.match(requested[1], /qn=64/u);
  assert.equal(result.mediaUrl, 'https://cdn.example/video.mp4');
  assert.equal(result.title, '测试');
  assert.equal(result.size, 100);
  assert.equal(result.publishedAt, 1789113600);
});

test('B站公开接口携带配置的 Cookie，避免匿名请求被风控返回 412', async () => {
  const calls = [];
  const cookie = 'SESSDATA=test-session; buvid3=test-buvid';
  await resolveBilibiliMedia('https://www.bilibili.com/video/BV1DV5v6HELu', {
    bilibiliCookie: cookie,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), cookie: options.headers?.cookie });
      if (String(url).includes('/view?')) {
        return new Response(JSON.stringify({ code: 0, data: { cid: 99, title: 'Cookie 测试' } }));
      }
      return new Response(JSON.stringify({
        code: 0, data: { durl: [{ size: 100, url: 'https://cdn.example/cookie.mp4' }] },
      }));
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.cookie), [cookie, cookie]);
  assert.match(calls[0].url, /\/x\/web-interface\/view/u);
  assert.match(calls[1].url, /\/x\/player\/playurl/u);
});

test('B站单文件 MP4 注册为流式中转，不等待完整下载', async () => {
  const resolver = new MediaResolver({ enabled: true, cacheTtlMs: 60_000 });
  const result = resolver.registerRemoteMedia({
    mediaUrl: 'https://cdn.example/video.mp4', size: 1234, title: '流式视频',
    backupMediaUrls: ['https://cdn.example/backup.mp4'],
    publishedAt: 1789113600,
    requestHeaders: { referer: 'https://www.bilibili.com/' },
  });
  const resource = await resolver.getMediaFile(result.mediaId);
  assert.equal(result.streamed, true);
  assert.equal(result.publishedAt, 1789113600);
  assert.equal(result.downloadBytes, 0);
  assert.equal(resource.remote, true);
  assert.equal(resource.remoteUrl, 'https://cdn.example/video.mp4');
  assert.deepEqual(resource.backupUrls, ['https://cdn.example/backup.mp4']);
  resolver.close();
});

test('已知超过 500 MiB 的远程视频在注册代理前拒绝', () => {
  const resolver = new MediaResolver({ enabled: true });
  try {
    assert.throws(
      () => resolver.registerRemoteMedia({
        mediaUrl: 'https://cdn.example/huge.mp4', size: 500 * 1024 * 1024 + 1,
      }),
      /视频文件超过 500 MiB/u,
    );
  } finally { resolver.close(); }
});

test('B站优先 API 返回的 UPOS 备用 CDN，保留主地址且去重', async () => {
  const primary = 'https://edge.example/video.mp4?token=original';
  const fast = 'https://upos-sz-mirrorcos.bilivideo.com/video.mp4?token=backup';
  const result = await resolveBilibiliMedia('https://www.bilibili.com/video/BV1fhYN6AEay', {
    fetchImpl: async url => new Response(JSON.stringify({code:0,data:String(url).includes('/view?')
      ? {cid:99,title:'原视频',owner:{name:'原作者'}}
      : {quality:64,durl:[{url:primary,size:100,backup_url:[fast,fast,'javascript:invalid',primary]}]},
    })),
  });
  assert.equal(result.mediaUrl, fast);
  assert.deepEqual(result.backupMediaUrls, [primary]);
  assert.equal(result.quality, 64);
  assert.equal(result.author, '原作者');
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

test('媒体主链把 Provider 图文结果保留为 gallery', async () => {
  const resolver = new MediaResolver({
    enabled: true, cacheTtlMs: 0,
    providerResolver: async () => ({
      title: '图文标题', description: '图文正文',
      author: '图文原作者', avatarUrl: 'https://cdn.example/avatar.jpg', tags: ['话题'],
      images: ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg'],
    }),
  });
  const result = await resolver.resolve({ url: 'https://xhslink.com/gallery', provider: 'xiaohongshu' });
  assert.equal(result.extractor, 'provider-gallery');
  assert.equal(result.images.length, 2);
  assert.equal(result.title, '图文标题');
  assert.equal(result.coverUrl, 'https://cdn.example/1.jpg');
  assert.equal(result.author, '图文原作者');
  assert.equal(result.avatarUrl, 'https://cdn.example/avatar.jpg');
  assert.deepEqual(result.tags, ['话题']);
  resolver.close();
});

test('Provider 原作者/正文/tag 经跨群缓存复用且没有视频下载', async () => {
  let calls = 0;
  const resolver = new MediaResolver({ enabled: true,
    providerResolver: async () => {
      calls++;
      return { mediaUrl: 'https://cdn.example/v.mp4', title: '视频',
        coverUrl: 'https://cdn.example/cover.jpg', author: '原作者',
        avatarUrl: 'https://cdn.example/author.jpg', description: '正文 #模型[话题]#', tags: ['模型'] };
    } });
  try {
    const results = await Promise.all(['group-a', 'group-b'].map(groupId => resolver.resolve({
      url: 'https://xhslink.com/m/shared', provider: 'xiaohongshu', groupId } )));
    const cached = await resolver.resolve({ url: 'https://xhslink.com/m/shared', provider: 'xiaohongshu' });
    assert.equal(calls, 1);
    assert.strictEqual(results[0], cached);
    assert.equal(cached.author, '原作者');
    assert.equal(cached.avatarUrl, 'https://cdn.example/author.jpg');
    assert.equal(cached.description, '正文 #模型[话题]#');
    assert.deepEqual(cached.tags, ['模型']);
    assert.equal(cached.downloadBytes, 0);
  } finally { resolver.close(); }
});

test('缺少可选卡片元数据也复用媒体缓存，不为生成卡片重复解析', async () => {
  let calls = 0;
  const resolver = new MediaResolver({ enabled: true, providerResolver: async () => {
    calls++; return { mediaUrl: 'https://cdn.example/a.mp4' };
  } });
  try {
    const candidate = { url: 'https://example.com/share', provider: 'unknown' };
    await resolver.resolve(candidate);
    await resolver.resolve(candidate);
    assert.equal(calls, 1);
  } finally { resolver.close(); }
});

test('B站简介和原作者经过播放代理仍完整保留', async () => {
  const resolver = new MediaResolver({ enabled: true });
  try {
    const result = resolver.registerRemoteMedia({ mediaUrl: 'https://cdn.example/video.mp4',
      author: 'UP主', avatarUrl: 'https://cdn.example/avatar.jpg', description: '第一行\n#高达 第二行',
      coverUrl: 'https://cdn.example/cover.jpg' });
    assert.equal(result.author, 'UP主');
    assert.equal(result.avatarUrl, 'https://cdn.example/avatar.jpg');
    assert.equal(result.description, '第一行\n#高达 第二行');
    assert.equal(result.streamed, true);
  } finally { resolver.close(); }
});

test('本地动图媒体注册后保留 image/gif 类型', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'media-gif-'));
  const filePath = path.join(directory, 'example.gif');
  await writeFile(filePath, Buffer.from('GIF89a'));
  const resolver = new MediaResolver({ enabled: true, cacheTtlMs: 60_000 });
  try {
    const result = resolver.registerMedia({
      filePath, outputBytes: 6, mediaType: 'image/gif',
    });
    const resource = await resolver.getMediaFile(result.mediaId);
    assert.equal(resource.mediaType, 'image/gif');
    assert.equal(result.url, `http://qq-bot:8787/v1/qq/media/${result.mediaId}`);
  } finally {
    resolver.close();
    await rm(directory, { recursive: true, force: true });
  }
});
