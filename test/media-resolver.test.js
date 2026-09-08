import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaResolver } from '../src/media-resolver.js';

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
