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

test('小红书 .cn 短链、旧短链和笔记页统一识别，仿冒域名保持普通链接', () => {
  for (const url of [
    'https://xhslink.cn/o/6IV5SHvQTnX',
    'http://xhslink.cn/o/66ay0OpRoGJ',
    'https://www.xhslink.cn/o/example',
    'https://xhslink.com/m/example',
    'https://www.xiaohongshu.com/explore/note?xsec_token=abc%2B123',
  ]) {
    assert.equal(classifyMediaUrl(url), 'xiaohongshu', url);
    assert.deepEqual(extractMediaUrls({ text: `分享 ${url}，打开小红书` }), [url]);
    assert.deepEqual(extractMediaUrls({ richSegments: [{ type: 'json', data: {
      data: JSON.stringify({ meta: { detail_1: { qqdocurl: url } } }),
    } }] }), [url]);
  }
  for (const url of ['https://notxhslink.cn/o/demo', 'https://xhslink.cn.example.org/o/demo',
    'https://xiaohongshu.com.example.org/explore/demo']) {
    assert.equal(classifyMediaUrl(url), 'unknown', url);
  }
});

test('rejects local and non-http urls', () => {
  assert.equal(normalizeMediaUrl('http://127.0.0.1/a'), '');
  assert.equal(normalizeMediaUrl('file:///tmp/a.mp4'), '');
});
