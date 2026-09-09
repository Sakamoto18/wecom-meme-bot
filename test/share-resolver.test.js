import test from 'node:test';
import assert from 'node:assert/strict';
import { extractXhsPageNote, resolveSharedUrl } from '../src/share-resolver.js';

// Structure observed in the actual QQ shares AHZY6eoPfym / 47pnZUAJib8.
// Media URLs and text are substituted; this is a regression fixture, not a live fetch.
const noteId = '6a82dfd7000000003400ff74';
const canonicalUrl = `https://www.xiaohongshu.com/discovery/item/${noteId}?xsec_source=app_share`;
function page(note) {
  return `<script>window.__INITIAL_STATE__=${JSON.stringify({
    note: { noteDetailMap: { [noteId]: { note: { noteId, ...note } } } },
  }).replace('"__UNDEFINED__"', 'undefined')};</script>`;
}

test('实际分享页面结构：完整图集保持顺序，话题只去掉标记', async () => {
  const html = page({ type: 'normal', title: '图文标题', desc: 'undefined 正文 #英语[话题]#',
    optional: '__UNDEFINED__', imageList: [1, 2, 3, 4, 5].map((n) => ({
      infoList: [{ imageScene: 'WB_PRV', url: `https://cdn.example/preview${n}.jpg` },
        { imageScene: 'WB_DFT', url: `https://cdn.example/${n}.jpg` }],
    })) });
  const result = await resolveSharedUrl('https://xhslink.com/m/AHZY6eoPfym', {
    fetchImpl: async () => ({ ok: true, url: canonicalUrl,
      headers: new Headers({ 'content-type': 'text/html' }), text: async () => html }),
  });
  assert.equal(result.mediaKind, 'gallery');
  assert.equal(result.description, 'undefined 正文 #英语#');
  assert.deepEqual(result.images, [1, 2, 3, 4, 5].map((n) => `https://cdn.example/${n}.jpg`));
});

test('视频笔记的封面不应被当作图文图集', () => {
  const result = extractXhsPageNote(page({ type: 'video', imageList: [{ urlDefault: 'https://cdn.example/cover.jpg' }],
    video: { media: { stream: { h264: [
      { height: 1080, masterUrl: 'https://cdn.example/1080.mp4' },
      { height: 720, masterUrl: 'https://cdn.example/720.mp4' },
    ] } } } }), canonicalUrl);
  assert.equal(result.mediaUrl, 'https://cdn.example/720.mp4');
  assert.deepEqual(result.images, []);
});

test('视频流缺失时也不把视频封面当作图文成功', () => {
  const result = extractXhsPageNote(page({ type: 'video', imageList: [{ url: 'https://cdn.example/cover.jpg' }] }), canonicalUrl);
  assert.equal(result.mediaUrl, '');
  assert.deepEqual(result.images, []);
});

test('不执行页面脚本，不误取其他笔记数据，不绕过错误页', () => {
  assert.equal(extractXhsPageNote('<script>window.__INITIAL_STATE__=(()=>{throw 1})()</script>', canonicalUrl), null);
  assert.equal(extractXhsPageNote(page({ type: 'normal' }), canonicalUrl.replace(noteId, 'other')), null);
  assert.equal(extractXhsPageNote(page({ type: 'normal' }), 'https://www.xiaohongshu.com/404'), null);
});

test('通用分享解析器跟随跳转并提取公开视频元数据', async () => {
  const result = await resolveSharedUrl('https://share.example/s/demo', {
    fetchImpl: async () => new Response(
      '<meta property="og:title" content="Demo"><meta property="og:image" content="https://cdn.example/cover.jpg"><meta property="og:video" content="https://cdn.example/video.mp4">',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ),
  });
  assert.equal(result.title, 'Demo');
  assert.equal(result.canonicalUrl, 'https://share.example/s/demo');
  assert.equal(result.mediaUrl, 'https://cdn.example/video.mp4');
});
