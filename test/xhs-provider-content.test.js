import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeXhsProviderData } from '../src/xhs-provider.js';

test('图文类型返回图集，即使同时带有非正文视频字段', () => {
  const result = normalizeXhsProviderData({ media_type: 'gallery', images: ['https://cdn.example/1.jpg'],
    video_url: 'https://cdn.example/ad.mp4', desc: '#英语[话题]#' });
  assert.equal(result.mediaUrl, '');
  assert.equal(result.images.length, 1);
  assert.equal(result.description, '#英语#');
});
test('视频和封面同时返回时仅选择视频', () => {
  const result = normalizeXhsProviderData({ media_type: 'video', video_url: 'https://cdn.example/video.mp4',
    images: ['https://cdn.example/cover.jpg'] });
  assert.equal(result.mediaUrl, 'https://cdn.example/video.mp4');
  assert.deepEqual(result.images, []);
});
test('视频流缺失不能以封面充当成功图文', () => {
  assert.throws(() => normalizeXhsProviderData({ media_type: 'video', images: ['https://cdn.example/cover.jpg'] }), /视频流/);
});

test('实际 /resolve 扁平作者信息透传，不递归误取tag或封面为作者', () => {
  const data = { media_type: 'video', video_url: 'https://cdn.example/video.mp4',
    cover: 'https://cdn.example/cover.jpg', author: '原作者', avatarUrl: 'https://cdn.example/avatar.jpg',
    tags: ['话题'], description: '正文 #话题[话题]#' };
  const result = normalizeXhsProviderData(data);
  assert.equal(result.author, '原作者');
  assert.equal(result.avatarUrl, 'https://cdn.example/avatar.jpg');
  assert.deepEqual(result.tags, ['话题']);
  const missing = normalizeXhsProviderData({ ...data, author: '', avatarUrl: '',
    tagList: [{ name: '不是作者' }], unrelated: { image: 'https://cdn.example/ad.jpg' } });
  assert.equal(missing.author, '');
  assert.equal(missing.avatarUrl, '');
});
