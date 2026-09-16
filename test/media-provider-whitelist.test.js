import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaResolver } from '../src/media-resolver.js';
import { QqBotService } from '../src/qq-service.js';

const DOUYIN = 'https://v.douyin.com/whitelist-example/';
const BILIBILI = 'https://b23.tv/whitelist';
const XHS = 'https://xhslink.com/a/whitelist';
// 用户的两个群：只放行抖音，其余平台保持关闭。
const WHITELIST_GROUPS = ['821259340', '239375116'];

function buildService({ resolver, allowed, excluded = WHITELIST_GROUPS }) {
  return new QqBotService({
    mediaResolver: resolver,
    logger: { info() {}, warn() {} },
    mediaExcludedGroups: excluded,
    mediaGroupAllowedProviders: allowed,
  });
}

async function withResolver(run) {
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-whitelist-'));
  const resolver = new MediaResolver({ enabled: true, cacheDirectory,
    command: 'must-not-run-yt-dlp', publicBaseUrl: 'http://qq-bot:8787',
    providerResolver: async () => ({
      mediaUrl: '', images: ['https://cdn.example/1.webp', 'https://cdn.example/2.webp'],
      title: '图文', coverUrl: 'https://cdn.example/1.webp', author: 'a', tags: [],
    }),
  });
  try {
    await run(resolver);
  } finally {
    resolver.close();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
}

test('白名单群放行抖音，其余平台仍然关闭', async () => {
  await withResolver(async (resolver) => {
    const allowed = new Map(WHITELIST_GROUPS.map((id) => [id, new Set(['douyin'])]));
    const service = buildService({ resolver, allowed });
    for (const group_id of WHITELIST_GROUPS) {
      const douyin = await service.handleMessage({ group_id, user_id: 'tester',
        text: DOUYIN, media_share: true });
      assert.equal(douyin.mode, 'media-gallery', `${group_id} 应放行抖音`);

      for (const blocked of [BILIBILI, XHS]) {
        // 不放行的平台不进媒体解析：落到普通文本路径，因此不会返回媒体结果。
        const result = await service.handleMessage({ group_id, user_id: 'tester',
          text: blocked, media_share: true }).catch((error) => ({ mode: `threw:${error.message}` }));
        assert.notEqual(result.mode, 'media-gallery', `${group_id} 不应解析 ${blocked}`);
        assert.notEqual(result.mode, 'media', `${group_id} 不应解析 ${blocked}`);
        assert.notEqual(result.mode, 'media-excluded', `${group_id} 的 ${blocked} 应作普通文本`);
      }
    }
  });
});

test('白名单优先于整群排除，无需从排除名单里摘掉这两个群', async () => {
  await withResolver(async (resolver) => {
    const allowed = new Map([['821259340', new Set(['douyin'])]]);
    // 该群同时留在整群排除名单里，白名单更精确所以生效。
    const service = buildService({ resolver, allowed, excluded: ['821259340'] });
    const result = await service.handleMessage({ group_id: '821259340', user_id: 'tester',
      text: DOUYIN, media_share: true });
    assert.equal(result.mode, 'media-gallery');
  });
});

test('未列入白名单的群沿用原有整群开关', async () => {
  await withResolver(async (resolver) => {
    const allowed = new Map([['821259340', new Set(['douyin'])]]);
    const service = buildService({ resolver, allowed, excluded: ['999888777'] });
    // 在排除名单里：抖音也不放行。
    const excludedResult = await service.handleMessage({ group_id: '999888777',
      user_id: 'tester', text: DOUYIN, media_share: true });
    assert.equal(excludedResult.mode, 'media-excluded');
    // 两个名单都不在：全平台开放。
    const openResult = await service.handleMessage({ group_id: '1109147947',
      user_id: 'tester', text: DOUYIN, media_share: true });
    assert.equal(openResult.mode, 'media-gallery');
  });
});

test('混合消息里带放行平台时仍然解析该平台', async () => {
  await withResolver(async (resolver) => {
    const allowed = new Map([['821259340', new Set(['douyin'])]]);
    const service = buildService({ resolver, allowed });
    const result = await service.handleMessage({ group_id: '821259340', user_id: 'tester',
      text: `看这个 ${BILIBILI} 还有 ${DOUYIN}`, media_share: true });
    assert.equal(result.mode, 'media-gallery');
  });
});

test('没有白名单配置时行为与改动前一致', async () => {
  await withResolver(async (resolver) => {
    const service = buildService({ resolver, allowed: new Map(), excluded: ['821259340'] });
    const blocked = await service.handleMessage({ group_id: '821259340', user_id: 'tester',
      text: DOUYIN, media_share: true });
    assert.equal(blocked.mode, 'media-excluded');
    const open = await service.handleMessage({ group_id: '1109147947', user_id: 'tester',
      text: BILIBILI, media_share: true });
    assert.equal(open.mode, 'media-gallery');
  });
});
