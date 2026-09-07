import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMediaUrl,
  extractMediaUrls,
  normalizeMediaUrl,
} from '../src/media-link-extractor.js';

test('extracts urls from nested QQ json card payloads', () => {
  const card = JSON.stringify({
    app: 'com.tencent.miniapp',
    meta: { detail_1: { qqdocurl: 'https://v.douyin.com/abc/?from=qq' } },
  });
  assert.deepEqual(extractMediaUrls({ richSegments: [{ type: 'json', data: { data: card } }] }), [
    'https://v.douyin.com/abc/?from=qq',
  ]);
});

test('extracts xiaohongshu short links from share text', () => {
  assert.deepEqual(extractMediaUrls({ text: '复制打开小红书 https://xhslink.com/aBc123，查看笔记' }), [
    'https://xhslink.com/aBc123',
  ]);
  assert.equal(classifyMediaUrl('https://xhslink.com/aBc123'), 'xiaohongshu');
});

test('rejects local and non-http urls', () => {
  assert.equal(normalizeMediaUrl('http://127.0.0.1/a'), '');
  assert.equal(normalizeMediaUrl('file:///tmp/a.mp4'), '');
});
