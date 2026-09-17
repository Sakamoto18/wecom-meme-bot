/**
 * Provider 拿不到可播媒体时，页面元数据必须留给 yt-dlp 结果补全。
 *
 * 线上现象：同一条抖音链接，第一次 provider 成功 → 卡片有作者/头像/封面/简介；
 * 第二次 provider 偶发失败 → 走 yt-dlp → 卡片只剩一个标题（14 KB 空卡）。
 * provider 其实已经从页面拿到了那些元数据，只是在没有媒体时把它们一起丢了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';



import { createDouyinProvider } from '../src/douyin-provider.js';

const META = {
  title: '#麦晓雯 #三角洲行动 #维什戴尔cos - 抖音',
  description: '#麦晓雯 - 空之狸于20260906发布在抖音 - 抖音',
  author: '空之狸',
  avatar_url: 'https://p3.douyinpic.com/aweme-avatar/x.jpeg',
  cover: 'https://p3-pc-sign.douyinpic.com/cover~tplv.jpeg?x-signature=a%2Fb%3D',
  tags: ['麦晓雯', '三角洲行动'],
};

function mockProvider(payload) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
  return createDouyinProvider({ providerUrl: 'http://provider.test/resolve' });
}

test('metadata-only 结果不再被当成失败，且带齐卡片字段', async () => {
  const provider = mockProvider({ status: 'success', data: {
    media_type: 'metadata', video_url: '', images: [], ...META,
  } });
  const resolved = await provider({ platform: 'douyin', url: 'https://v.douyin.com/x/' });
  assert.equal(resolved.metadataOnly, true);
  assert.equal(resolved.mediaUrl, '', '没有可播地址');
  assert.deepEqual(resolved.images, []);
  // 这些字段就是卡片上缺掉的东西。
  assert.equal(resolved.author, '空之狸');
  assert.equal(resolved.avatarUrl, META.avatar_url);
  assert.equal(resolved.coverUrl, META.cover);
  assert.equal(resolved.title, META.title);
  assert.match(resolved.description, /空之狸/);
  assert.deepEqual(resolved.tags, META.tags);
});

test('真正一无所获时仍然报失败', async () => {
  const provider = mockProvider({ status: 'success', data: {
    media_type: 'metadata', video_url: '', images: [],
  } });
  await assert.rejects(
    provider({ platform: 'douyin', url: 'https://v.douyin.com/x/' }),
    /未返回可用视频地址/,
  );
});

test('视频与图集结果不受 metadata 分支影响', async () => {
  let provider = mockProvider({ status: 'success', data: {
    media_type: 'video', video_url: 'https://cdn.example/v.mp4', ...META,
  } });
  let resolved = await provider({ platform: 'douyin', url: 'https://v.douyin.com/v/' });
  assert.equal(resolved.mediaUrl, 'https://cdn.example/v.mp4');
  assert.equal(resolved.metadataOnly, false);

  provider = mockProvider({ status: 'success', data: {
    media_type: 'images', video_url: '',
    images: ['https://p3.douyinpic.com/a~tplv-dy-aweme-images:q75.webp'], ...META,
  } });
  resolved = await provider({ platform: 'douyin', url: 'https://v.douyin.com/n/' });
  assert.equal(resolved.mediaUrl, '');
  assert.equal(resolved.images.length, 1);
  assert.equal(resolved.metadataOnly, false);
});

test('Provider 元数据覆盖公开页面，但不抹掉公开页面独有的字段', async () => {
  const { pruneEmpty } = await import('../src/media-resolver.js');
  // resolver 里的合并写法：{...公开页面, ...pruneEmpty(Provider)}
  const fromPublicPage = {
    title: '公开页面标题', coverUrl: '', author: '', avatarUrl: '',
    description: '公开页面简介', tags: [], canonicalUrl: 'https://www.douyin.com/video/1',
  };
  const fromProvider = {
    title: META.title, coverUrl: META.cover, author: META.author,
    avatarUrl: META.avatar_url, description: '', tags: META.tags,
  };
  const merged = { ...fromPublicPage, ...pruneEmpty(fromProvider) };
  // Provider 有值的字段胜出。
  assert.equal(merged.title, META.title);
  assert.equal(merged.coverUrl, META.cover);
  assert.equal(merged.author, META.author);
  assert.deepEqual(merged.tags, META.tags);
  // Provider 为空的字段保留公开页面的值，而不是被空串抹掉。
  assert.equal(merged.description, '公开页面简介');
  // 公开页面独有的字段不能丢，sourceKey 依赖它。
  assert.equal(merged.canonicalUrl, 'https://www.douyin.com/video/1');
});

test('pruneEmpty 丢掉空值、保留 0 和 false', async () => {
  const { pruneEmpty } = await import('../src/media-resolver.js');
  assert.deepEqual(
    pruneEmpty({ a: '', b: null, c: undefined, d: [], e: 'x', f: 0, g: false, h: ['t'] }),
    { e: 'x', f: 0, g: false, h: ['t'] },
  );
  assert.deepEqual(pruneEmpty(null), {});
  assert.deepEqual(pruneEmpty(undefined), {});
});

test('yt-dlp 结果的空字段会被这份元数据补上', async () => {
  // 复现 resolver 里的补全写法，确认它认的是"空才补"。
  const downloaded = { title: '', coverUrl: '', author: '', avatarUrl: '', description: '', tags: undefined };
  const publicMetadata = {
    title: META.title, coverUrl: META.cover, author: META.author,
    avatarUrl: META.avatar_url, description: META.description, tags: META.tags,
  };
  downloaded.title ||= publicMetadata.title || '';
  downloaded.coverUrl ||= publicMetadata.coverUrl || '';
  downloaded.author ||= publicMetadata.author || '';
  downloaded.avatarUrl ||= publicMetadata.avatarUrl || '';
  downloaded.description ||= publicMetadata.description || '';
  downloaded.tags ||= publicMetadata.tags || [];
  assert.equal(downloaded.coverUrl, META.cover, '封面必须补上，这是空卡片的关键字段');
  assert.equal(downloaded.author, META.author);
  assert.equal(downloaded.avatarUrl, META.avatar_url);
  assert.deepEqual(downloaded.tags, META.tags);
});
