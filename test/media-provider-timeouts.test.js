import test from 'node:test';
import assert from 'node:assert/strict';
import { createDouyinProvider } from '../src/douyin-provider.js';
import { createXhsProvider } from '../src/xhs-provider.js';

test('浏览器 Provider 默认 HTTP 预算覆盖排队、解析和页面清理，并保留显式超时配置', async (t) => {
  const budgets = [];
  t.mock.method(AbortSignal, 'timeout', ms => {
    budgets.push(ms);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    status: 'success', data: { type_verified: true, source_id: '123', media_type: 'video', video_url: 'https://cdn.example/v.mp4' },
  })));
  await createDouyinProvider({ providerUrl: 'http://provider/resolve' })({ platform: 'douyin' });
  await createXhsProvider({ providerUrl: 'http://provider/xhs/resolve' })({ platform: 'xiaohongshu' });
  assert.ok(budgets.slice(0, 2).every(ms => ms > (40 + 35 + 2) * 1000));
  await createXhsProvider({ providerUrl: 'http://provider/xhs/resolve', timeoutMs: 1234 })({ platform: 'xiaohongshu' });
  assert.equal(budgets[2], 1234);
});
