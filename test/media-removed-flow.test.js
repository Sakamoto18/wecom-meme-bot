/**
 * 源内容已删除时的整链行为：不再降级、日志分开、用量库标 removed。
 *
 * 关键在"不再降级"：以前 provider 报错后一律交给 yt-dlp，而 yt-dlp 对被删的
 * 链接只会回一句 Unsupported URL，把真正的原因盖掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaResolver } from '../src/media-resolver.js';
import { QqBotService } from '../src/qq-service.js';
import { removedError, isRemovedError } from '../src/media-removed.js';

const REMOVED_MSG = removedError('抖音', '抖音提示「你要观看的图文不存在」');

async function withResolver(providerResolver, run) {
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'removed-flow-'));
  const lines = [];
  const logger = {
    info: (m) => lines.push(['info', String(m)]),
    warn: (m) => lines.push(['warn', String(m)]),
  };
  const resolver = new MediaResolver({
    enabled: true, cacheDirectory, publicBaseUrl: 'http://qq-bot:8787',
    publicResolverEnabled: false,
    // yt-dlp 一旦被调用就会 ENOENT，用它来证明降级有没有发生
    command: 'must-not-run-yt-dlp',
    providerResolver, logger,
  });
  try {
    await run(resolver, lines, logger);
  } finally {
    resolver.close();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
}

test('内容已删除时不降级到 yt-dlp，原因原样抛出', async () => {
  await withResolver(async () => { throw new Error(REMOVED_MSG); }, async (resolver, lines) => {
    await assert.rejects(
      resolver.resolve({ url: 'https://v.douyin.com/removed/', provider: 'douyin' }),
      (error) => {
        assert.ok(isRemovedError(error), '错误必须仍是"源内容已删除"');
        assert.match(error.message, /你要观看的图文不存在/);
        // 降级发生过的话，消息里会带 yt-dlp 的 ENOENT
        assert.doesNotMatch(error.message, /must-not-run-yt-dlp|ENOENT|Unsupported URL/,
          '不该再走 yt-dlp');
        return true;
      },
    );
    const removedLog = lines.find(([, m]) => m.includes('内容已删除'));
    assert.ok(removedLog, '要有一条明确的已删除日志');
    assert.equal(removedLog[0], 'info', '这不是我们的故障，用 info 而非 warn');
  });
});

test('被删页面残留的零碎元数据不能让判定退化成降级', async () => {
  // 实测踩到的坑：被删的抖音页面上仍留着推荐位封面，provider 若先走
  // metadata-only 分支，上游就会拿它去降级 yt-dlp，真正的原因被
  // "Unsupported URL" 盖掉。判"已删除"必须优先。
  await withResolver(async () => ({
    mediaUrl: '', images: [], metadataOnly: true,
    title: '你要观看的图文不存在', coverUrl: 'https://p3.douyinpic.com/recommend~tplv.jpeg',
    author: '', description: '', tags: [],
  }), async (resolver, lines) => {
    await assert.rejects(
      resolver.resolve({ url: 'https://v.douyin.com/removed/', provider: 'douyin' }),
      (error) => {
        assert.ok(isRemovedError(error), '应判为已删除而不是走降级');
        assert.doesNotMatch(error.message, /must-not-run-yt-dlp|ENOENT|Unsupported URL/);
        return true;
      },
    );
    assert.ok(!lines.some(([, m]) => m.includes('转 yt-dlp 取流')),
      '不该进入元数据补全的降级路径');
  });
});

test('普通 provider 失败仍然降级到 yt-dlp', async () => {
  await withResolver(async () => { throw new Error('抖音 Provider 失败 stage=browser'); },
    async (resolver, lines) => {
      await assert.rejects(
        resolver.resolve({ url: 'https://v.douyin.com/x/', provider: 'douyin' }),
        (error) => {
          // 证明确实尝试过 yt-dlp
          assert.match(error.message, /must-not-run-yt-dlp|ENOENT/);
          return true;
        },
      );
      assert.ok(lines.some(([level, m]) => level === 'warn' && m.includes('尝试公开页面解析')),
        '普通失败要保持原有的降级日志');
    });
});

// B站走的是 resolveBilibiliMedia 而非 providerResolver，MediaResolver 没有对应
// 的注入点，这里无法真实驱动那条分支；它的判定在 media-removed.test.js 里用
// fetchImpl 注入真实业务码覆盖，resolver 的"不降级"由上面两个用例共同保证
// （isRemovedError 是同一个判据、同一处 throw）。

test('qq-service 把已删除记成 removed 而不是 resolve 失败', async () => {
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'removed-usage-'));
  const recorded = [];
  const lines = [];
  const resolver = new MediaResolver({
    enabled: true, cacheDirectory, publicBaseUrl: 'http://qq-bot:8787',
    publicResolverEnabled: false, command: 'must-not-run-yt-dlp',
    logger: { info() {}, warn() {} },
    providerResolver: async () => { throw new Error(REMOVED_MSG); },
  });
  const service = new QqBotService({
    mediaResolver: resolver,
    logger: {
      info: (m) => lines.push(['info', String(m)]),
      warn: (m) => lines.push(['warn', String(m)]),
    },
    mediaUsageTracker: { record: (row) => recorded.push(row) },
  });
  try {
    const result = await service.handleMessage({
      group_id: '1109147947', user_id: 'tester',
      text: 'https://v.douyin.com/removed/', media_share: true,
    });
    assert.equal(result.mode, 'media-unavailable', '对用户仍是失败，会挂失败表情');
    assert.deepEqual(result.messages, [{
      type: 'text',
      text: '这个分享的内容已被删除，无法抓取。',
    }], '删除分支必须给用户明确提示');
    const failure = recorded.find((row) => row.status === 'failed');
    assert.ok(failure, '要记一条失败');
    assert.equal(failure.errorStage, 'removed', '阶段应为 removed，便于事后区分');
    const log = lines.find(([, m]) => m.includes('媒体源内容已删除'));
    assert.ok(log, '要有一条专门的已删除日志');
    assert.equal(log[0], 'info');
    assert.ok(!lines.some(([level, m]) => level === 'warn' && m.includes('媒体源解析失败')),
      '不该再同时报成需要排查的解析失败');
  } finally {
    resolver.close();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});
