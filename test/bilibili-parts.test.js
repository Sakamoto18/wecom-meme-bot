import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extractBilibiliPage, extractBilibiliVideoIdFromToolOutput, resolveBilibiliMedia,
} from '../src/bilibili-provider.js';
import { MediaResolver, normalizeDownloadSource } from '../src/media-resolver.js';
import { mediaCandidates } from '../src/media-link-extractor.js';
import { QqBotService } from '../src/qq-service.js';

const VIDEO = 'https://www.bilibili.com/video/BV1Gh411t7WY';
const SHORT = 'https://b23.tv/part-two';
const metadata = {
  title: '公园跳个舞', cid: 436920426, duration: 176, pic: 'https://cdn.example/cover.jpg',
  owner: { name: '原作者', face: 'https://cdn.example/avatar.jpg' },
  desc: '原稿简介', pubdate: 1630000000,
  pages: [
    { page: 1, cid: 436920426, part: '我好害羞', duration: 56 },
    { page: 2, cid: 436920316, part: '旁边有好多小朋友', duration: 60 },
    { page: 3, cid: 436920514, part: '手机竖屏', duration: 60 },
  ],
};
const logger = { info() {}, warn() {}, log() {} };
function mockApi(calls, { data = metadata, playFails = false, shortFails = false } = {}) {
  return async (input) => {
    const url = new URL(input);
    calls.push(url.href);
    if (url.hostname === 'b23.tv') {
      return shortFails ? new Response('', { status: 412 })
        : new Response('', { status: 302, headers: { location: `${VIDEO}/?p=2&share_source=copy_web` } });
    }
    if (url.pathname === '/x/web-interface/view') {
      return Response.json({ code: 0, data });
    }
    if (url.pathname === '/x/player/playurl') {
      if (playFails) return new Response('', { status: 503 });
      const cid = url.searchParams.get('cid');
      return Response.json({ code: 0, data: {
        quality: 64, durl: [{ url: `https://cdn.example/${cid}.mp4`, size: Number(cid) }],
      } });
    }
    throw new Error(`Unexpected request: ${url.href}`);
  };
}
async function resolverFor(t, fetchImpl, extra = {}) {
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'bilibili-parts-'));
  t.mock.method(globalThis, 'fetch', fetchImpl);
  const resolver = new MediaResolver({ enabled: true, cacheDirectory, logger, ...extra });
  t.after(async () => { resolver.close(); await rm(cacheDirectory, { recursive: true, force: true }); });
  return resolver;
}

test('QQ 文本、JSON/XML 卡片及播放器都保留分 P，缓存键去跟踪参数但不合并 P1/P2', () => {
  const shared = `${VIDEO}/?p=2&share_source=copy_web&vd_source=tracking`;
  const inputs = [
    { text: `【分享】 ${shared}` },
    { richSegments: [{ type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { qqdocurl: shared } } }) } }] },
    { richSegments: [`<item url="${VIDEO}/?share_source=qq&amp;p=2" />`] },
    { text: 'https://player.bilibili.com/player.html?bvid=BV1Gh411t7WY&page=2' },
  ];
  for (const input of inputs) {
    const candidate = mediaCandidates(input)[0];
    assert.equal(candidate.provider, 'bilibili');
    assert.equal(normalizeDownloadSource(candidate.url), `${VIDEO}?p=2`);
  }
  assert.equal(normalizeDownloadSource(`${VIDEO}/?p=1&share_source=qq`), VIDEO);
  assert.equal(normalizeDownloadSource(`${VIDEO}/?share_source=qq`), VIDEO);
  assert.notEqual(normalizeDownloadSource(`${VIDEO}?p=2`), normalizeDownloadSource(VIDEO));
  assert.equal(normalizeDownloadSource('https://player.bilibili.com/player.html?aid=123&page=3'), 'https://www.bilibili.com/video/av123?p=3');
  assert.equal(normalizeDownloadSource('https://xhslink.com/a?xsec_token=abc'), 'https://xhslink.com/a?xsec_token=abc');
});

test('B站卡片编码跳转中的分 P 也能提取', () => {
  assert.equal(extractBilibiliPage(`https://example.com/jump?target=${encodeURIComponent(`${VIDEO}?p=2`)}`), 2);
});

test('P2 选择自己的 cid、大小、标题和时长，保留原作者/简介', async () => {
  const calls = [];
  const result = await resolveBilibiliMedia(`${VIDEO}?p=2`, { fetchImpl: mockApi(calls) });
  const play = new URL(calls[1]);
  assert.equal(play.searchParams.get('cid'), '436920316');
  assert.equal(play.searchParams.get('qn'), '64');
  assert.equal(play.searchParams.has('p'), false);
  assert.equal(result.mediaUrl, 'https://cdn.example/436920316.mp4');
  assert.equal(result.size, 436920316);
  assert.equal(result.duration, 60);
  assert.equal(result.title, '公园跳个舞 · P2 旁边有好多小朋友');
  assert.equal(result.author, '原作者');
  assert.equal(result.description, '原稿简介');
  assert.equal(result.coverUrl, metadata.pic);
  assert.equal(result.page, 2);
  assert.equal(result.cid, '436920316');
});

test('没有分 P 参数默认 P1，时长用 P1 而不是整个稿件总长', async () => {
  const result = await resolveBilibiliMedia(VIDEO, { fetchImpl: mockApi([]) });
  assert.equal(result.cid, '436920426');
  assert.equal(result.duration, 56);
  assert.match(result.title, /P1 我好害羞/u);
});

test('按 pages.page 匹配分 P，不依赖数组顺序或默认 cid', async () => {
  const result = await resolveBilibiliMedia(`${VIDEO}?p=3`, {
    fetchImpl: mockApi([], { data: { ...metadata, pages: [...metadata.pages].reverse() } }),
  });
  assert.equal(result.cid, '436920514');
  assert.match(result.title, /P3 手机竖屏/u);
});

test('短链第一跳及工具恢复出的目标地址都保留 P2', async () => {
  const redirected = await resolveBilibiliMedia(SHORT, { fetchImpl: mockApi([]) });
  assert.equal(redirected.cid, '436920316');
  const recovered = extractBilibiliVideoIdFromToolOutput(
    `[BiliBili] Extracting URL: ${VIDEO}?p=2\n[BiliBili] 1Gh411t7WY: Downloading webpage\nHTTP Error 412`,
  );
  assert.deepEqual(recovered, { bvid: 'BV1Gh411t7WY', page: 2 });
  const result = await resolveBilibiliMedia(SHORT, {
    fetchImpl: mockApi([], { shortFails: true }), shortLinkIdResolver: async () => recovered,
  });
  assert.equal(result.cid, '436920316');
});

test('短链只恢复出 BV 时，多 P 稿件不会猜 P1，单 P 仍正常', async () => {
  const options = { shortLinkIdResolver: async () => ({ bvid: 'BV1Gh411t7WY' }) };
  await assert.rejects(resolveBilibiliMedia(SHORT, {
    ...options, fetchImpl: mockApi([], { shortFails: true }),
  }), { code: 'BILIBILI_PART_UNAVAILABLE' });
  const result = await resolveBilibiliMedia(SHORT, {
    ...options, fetchImpl: mockApi([], { shortFails: true, data: { ...metadata, pages: [metadata.pages[0]] } }),
  });
  assert.equal(result.cid, '436920426');
});

test('非法、越界或缺少分 P 数据时不请求默认播放流', async () => {
  for (const p of ['0', '-1', 'abc', '2.5', '9007199254740993', '4']) {
    const calls = [];
    await assert.rejects(resolveBilibiliMedia(`${VIDEO}?p=${p}`, { fetchImpl: mockApi(calls) }), {
      code: 'BILIBILI_PART_UNAVAILABLE',
    });
    assert.ok(!calls.some(url => url.includes('/playurl?')));
  }
  await assert.rejects(resolveBilibiliMedia(`${VIDEO}?p=2`, {
    fetchImpl: mockApi([], { data: { ...metadata, pages: [] } }),
  }), { code: 'BILIBILI_PART_UNAVAILABLE' });
});

test('主链并发和缓存复用只合并同一个 P，P1/P2 使用不同流', async (t) => {
  const calls = [];
  const resolver = await resolverFor(t, mockApi(calls));
  // Do not download real bytes: inspect the actual result handed to the proxy.
  t.mock.method(resolver, 'registerRemoteMedia', value => ({ ...value, url: value.mediaUrl }));
  const [one, two, again] = await Promise.all([
    resolver.resolve({ provider: 'bilibili', url: VIDEO }),
    resolver.resolve({ provider: 'bilibili', url: `${VIDEO}/?p=2&share_source=qq` }),
    resolver.resolve({ provider: 'bilibili', url: 'https://player.bilibili.com/player.html?bvid=BV1Gh411t7WY&page=2' }),
  ]);
  assert.equal(one.cid, '436920426');
  assert.equal(two.cid, '436920316');
  assert.equal(again, two);
  assert.equal(await resolver.resolve({ provider: 'bilibili', url: `${VIDEO}?p=2&vd_source=other` }), two);
  assert.equal(calls.filter(url => url.includes('/playurl?')).length, 2);
});

test('B站公开接口失败后 yt-dlp 仍收到短链解析出的 P2，不访问可能指向 P1 的页面元数据', async (t) => {
  const calls = [];
  const resolver = await resolverFor(t, mockApi(calls, { playFails: true }));
  const command = path.join(resolver.cacheDirectory, 'fake-yt-dlp');
  const argsFile = path.join(resolver.cacheDirectory, 'args.json');
  await writeFile(command, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));\nconst file = args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4');\nfs.writeFileSync(file, 'test video');\nconsole.log(JSON.stringify({ title: '错误默认标题', duration: 176 }));\nconsole.log(file);\n`, { mode: 0o700 });
  resolver.command = command;
  const result = await resolver.resolve({ provider: 'bilibili', url: SHORT });
  const args = JSON.parse(await readFile(argsFile, 'utf8'));
  assert.equal(args.at(-1), `${VIDEO}?p=2`);
  assert.ok(args.includes('--no-playlist'));
  assert.equal(result.page, 2);
  assert.equal(result.duration, 60);
  assert.match(result.title, /P2 旁边有好多小朋友/u);
  assert.equal(calls.length, 3, 'only redirect + view + playurl');
});

test('B站工具兜底也失败时，不再用 HTML 的默认视频顶替分 P', async (t) => {
  const calls = [];
  const resolver = await resolverFor(t, mockApi(calls, { playFails: true }), { command: 'missing-bili-test-ytdlp' });
  await assert.rejects(resolver.resolve({ provider: 'bilibili', url: `${VIDEO}?p=2` }), /ENOENT/u);
  assert.equal(calls.length, 2);
});

test('分 P 不存在由 QQ 返回明确提示，不能沉默或降级发送 P1', async (t) => {
  const calls = [];
  const records = [];
  const resolver = await resolverFor(t, mockApi(calls), { command: 'must-not-run-ytdlp' });
  const service = new QqBotService({ mediaResolver: resolver, logger,
    mediaUsageTracker: { record: row => records.push(row) } });
  const result = await service.handleMessage({
    group_id: '1109147947', user_id: 'tester', text: `${VIDEO}?p=4`, media_share: true,
  });
  assert.equal(result.mode, 'media-unavailable');
  assert.equal(result.messages[0].type, 'text');
  assert.match(result.messages[0].text, /P4 不存在/u);
  assert.equal(records[0].errorStage, 'part');
  assert.equal(calls.length, 1);
});
