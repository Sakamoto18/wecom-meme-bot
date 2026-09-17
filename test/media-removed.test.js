/**
 * 源站把内容删了，要和"我们抓取失败"分开。
 *
 * 起因：一条抖音图文被作者删除后，日志里只剩 yt-dlp 的 "Unsupported URL"，
 * 看上去像解析逻辑坏了，实际改代码也救不回来。三个平台都要能给出明确结论。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksRemoved, isBilibiliRemovedCode, isXhsRemovedCode,
  removedError, isRemovedError, REMOVED_ERROR_PREFIX,
} from '../src/media-removed.js';
import { createDouyinProvider } from '../src/douyin-provider.js';
import { createXhsProvider } from '../src/xhs-provider.js';
import { resolveBilibiliMedia } from '../src/bilibili-provider.js';

test('三平台的"内容不存在"文案都能识别', () => {
  const removed = [
    '你要观看的图文不存在',            // 抖音（实测原文）
    '你要观看的视频不存在',
    '该作品已删除',
    '笔记不存在',                      // 小红书
    '当前笔记已删除',
    '稿件不可见',                      // B站
    '啥都木有',
    '已被作者删除',
  ];
  for (const text of removed) {
    assert.ok(looksRemoved(text), `应识别为已删除：${text}`);
  }
});

test('正常内容和普通故障都不能被误判成已删除', () => {
  const notRemoved = [
    '', null, undefined,
    '窗花光影少妇写真。成熟女人特有的魅力 #光影人像',   // 正常标题
    '登录后查看高清视频',                              // 登录提示≠删除
    '签名失效或风控拦截',
    'yt-dlp 下载失败（ERROR: HTTP Error 403)',
    '媒体源解析失败',
    'ClientResponseError status=403',
    '页面未发现可下载的视频地址',                      // 抓取失败，不是删除
  ];
  for (const text of notRemoved) {
    assert.equal(looksRemoved(text), false, `不应判为已删除：${text}`);
  }
});

test('B站业务码按源站结论判定', () => {
  for (const code of [-404, 62002, 62004, 62012]) {
    assert.ok(isBilibiliRemovedCode(code), `code ${code} 应为已删除`);
  }
  // 这些是别的问题，不能算删除
  for (const code of [0, -400, -403, -509, -412, null, undefined, 'x']) {
    assert.equal(isBilibiliRemovedCode(code), false, `code ${code} 不应判为删除`);
  }
});

test('小红书业务码同理', () => {
  assert.ok(isXhsRemovedCode(-510001));
  assert.equal(isXhsRemovedCode(-100), false, '-100 是签名过期，不是删除');
  assert.equal(isXhsRemovedCode(0), false);
});

test('removedError 造出的消息能被 isRemovedError 认出', () => {
  const error = new Error(removedError('抖音', '抖音提示「你要观看的图文不存在」'));
  assert.ok(error.message.startsWith(REMOVED_ERROR_PREFIX));
  assert.ok(isRemovedError(error));
  assert.ok(isRemovedError(error.message));
  // 普通失败不能被认成删除
  assert.equal(isRemovedError(new Error('yt-dlp 下载失败')), false);
  assert.equal(isRemovedError(null), false);
});

test('抖音 Provider 把 removed 标记转成明确错误', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ status: 'failed', removed: true,
      msg: '抖音 Provider 失败 stage=gallery：content_removed: 抖音提示「你要观看的图文不存在」' }),
  });
  const provider = createDouyinProvider({ providerUrl: 'http://p.test/resolve' });
  await assert.rejects(
    provider({ platform: 'douyin', url: 'https://v.douyin.com/x/' }),
    (error) => {
      assert.ok(isRemovedError(error), '必须被判为源内容已删除');
      assert.match(error.message, /你要观看的图文不存在/, '要保留源站原话');
      return true;
    },
  );
});

test('抖音的普通失败不会被误标成已删除', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ status: 'failed',
      msg: '抖音 Provider 失败 stage=browser：no_video_resource: 页面未返回视频资源' }),
  });
  const provider = createDouyinProvider({ providerUrl: 'http://p.test/resolve' });
  await assert.rejects(
    provider({ platform: 'douyin', url: 'https://v.douyin.com/x/' }),
    (error) => {
      assert.equal(isRemovedError(error), false);
      return true;
    },
  );
});

test('小红书 Provider 同样区分两类', async () => {
  const provider = createXhsProvider({ providerUrl: 'http://p.test/resolve' });
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ status: 'failed', removed: true, msg: 'content_removed: 小红书提示「笔记不存在」' }),
  });
  await assert.rejects(
    provider({ platform: 'xiaohongshu', url: 'https://xhslink.com/a/x' }),
    (error) => {
      assert.ok(isRemovedError(error));
      assert.match(error.message, /笔记不存在/);
      return true;
    },
  );
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ status: 'failed', msg: '签名失效或风控拦截' }),
  });
  await assert.rejects(
    provider({ platform: 'xiaohongshu', url: 'https://xhslink.com/a/x' }),
    (error) => {
      assert.equal(isRemovedError(error), false, '签名问题不是内容删除');
      return true;
    },
  );
});

test('B站稿件不可见时给出明确结论而不是裸业务码', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ code: 62002, message: '稿件不可见', data: null }),
  });
  await assert.rejects(
    resolveBilibiliMedia('https://www.bilibili.com/video/BV1xx411c7mD', { fetchImpl }),
    (error) => {
      assert.ok(isRemovedError(error), '62002 应判为稿件不可见');
      assert.match(error.message, /62002|稿件不可见/);
      return true;
    },
  );
});

test('B站其他接口错误保持原样', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ code: -509, message: '请求过于频繁', data: null }),
  });
  await assert.rejects(
    resolveBilibiliMedia('https://www.bilibili.com/video/BV1xx411c7mD', { fetchImpl }),
    (error) => {
      assert.equal(isRemovedError(error), false, '限流不是内容删除');
      return true;
    },
  );
});
