import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createBuiltInMeme,
  createImageReplyItem,
  detectImageExtension,
  MemeStore,
} from '../src/meme-store.js';

test('内置兜底表情包是有效 PNG', async () => {
  const image = await createBuiltInMeme();
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(image.length > 5);
  assert.ok(image.length <= 10 * 1024 * 1024);
});

test('按图片内容识别真实格式，不依赖企微缓存文件扩展名', () => {
  assert.equal(detectImageExtension(Buffer.from('474946383961', 'hex')), '.gif');
  assert.equal(detectImageExtension(Buffer.from('89504e470d0a1a0a', 'hex')), '.png');
  assert.equal(detectImageExtension(Buffer.from('ffd8ff', 'hex')), '.jpg');
  assert.equal(detectImageExtension(Buffer.from('not-an-image')), null);
});

test('为流式回复生成企微要求的图片项', () => {
  const buffer = Buffer.from('89504e470d0a1a0a01', 'hex');
  const item = createImageReplyItem({ buffer });

  assert.deepEqual(item, {
    msgtype: 'image',
    image: {
      base64: buffer.toString('base64'),
      md5: createHash('md5').update(buffer).digest('hex'),
    },
  });
  assert.throws(
    () => createImageReplyItem({ buffer: Buffer.from('474946383961', 'hex') }),
    /只支持 JPG\/PNG/,
  );
});

test('龙图只从企微缓存索引中选择并按内容去重', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wecom-meme-bot-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const emotionDirectory = path.join(root, 'Emotion');
  const generalDirectory = path.join(root, 'general');
  await Promise.all([
    mkdir(emotionDirectory, { recursive: true }),
    mkdir(generalDirectory, { recursive: true }),
  ]);

  const dragonImage = Buffer.from('89504e470d0a1a0a01', 'hex');
  const generalImage = Buffer.from('89504e470d0a1a0a02', 'hex');
  const dragonPath = path.join(emotionDirectory, 'dragon-a.png');
  const duplicatePath = path.join(emotionDirectory, 'dragon-a-copy.png');
  const generalPath = path.join(generalDirectory, 'not-a-dragon.png');
  const indexPath = path.join(root, 'longtu-index.json');

  await Promise.all([
    writeFile(dragonPath, dragonImage),
    writeFile(duplicatePath, dragonImage),
    writeFile(generalPath, generalImage),
  ]);
  await writeFile(indexPath, JSON.stringify({
    entries: [
      { path: dragonPath, score: 0.1 },
      { path: duplicatePath, score: 0.2 },
      { path: generalPath, score: 0.3 },
    ],
  }));

  const store = new MemeStore([generalDirectory, emotionDirectory], {
    longtuIndexPath: indexPath,
    longtuSourceDirectory: emotionDirectory,
  });
  const stats = await store.getStats();
  const meme = await store.pick('longtu');

  assert.equal(stats.longtuImageCount, 1);
  assert.equal(meme.category, 'longtu');
  assert.equal(meme.sourcePath, dragonPath);
  assert.equal(meme.rank, 1);
});

test('龙图排除表按内容哈希过滤，并可只选择静态图片', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wecom-meme-bot-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const emotionDirectory = path.join(root, 'Emotion');
  await mkdir(emotionDirectory, { recursive: true });
  const excludedBuffer = Buffer.from('89504e470d0a1a0a11', 'hex');
  const staticBuffer = Buffer.from('89504e470d0a1a0a12', 'hex');
  const gifBuffer = Buffer.from('4749463839610013', 'hex');
  const excludedPath = path.join(emotionDirectory, 'excluded.png');
  const staticPath = path.join(emotionDirectory, 'static.png');
  const gifPath = path.join(emotionDirectory, 'animated.gif');
  const indexPath = path.join(root, 'longtu-index.json');
  const exclusionsPath = path.join(root, 'longtu-exclusions.json');

  await Promise.all([
    writeFile(excludedPath, excludedBuffer),
    writeFile(staticPath, staticBuffer),
    writeFile(gifPath, gifBuffer),
  ]);
  await writeFile(indexPath, JSON.stringify({
    entries: [
      { path: excludedPath, score: 0.1 },
      { path: gifPath, score: 0.2 },
      { path: staticPath, score: 0.3 },
    ],
  }));
  await writeFile(exclusionsPath, JSON.stringify({
    excludedSha256: [createHash('sha256').update(excludedBuffer).digest('hex')],
  }));

  const store = new MemeStore([emotionDirectory], {
    longtuIndexPath: indexPath,
    longtuExclusionsPath: exclusionsPath,
    longtuSourceDirectory: emotionDirectory,
  });
  const stats = await store.getStats();
  const meme = await store.pick('longtu', { allowedExtensions: ['.png', '.jpg'] });

  assert.equal(stats.longtuImageCount, 2);
  assert.equal(meme.sourcePath, staticPath);
  assert.equal(meme.extension, '.png');
});

test('拒绝选择通用表情包，并过滤超过龙图阈值的候选', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wecom-meme-bot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const emotionDirectory = path.join(root, 'Emotion');
  await mkdir(emotionDirectory, { recursive: true });
  const acceptedPath = path.join(emotionDirectory, 'accepted.png');
  const rejectedPath = path.join(emotionDirectory, 'rejected.png');
  await Promise.all([
    writeFile(acceptedPath, Buffer.from('89504e470d0a1a0a21', 'hex')),
    writeFile(rejectedPath, Buffer.from('89504e470d0a1a0a22', 'hex')),
  ]);
  const indexPath = path.join(root, 'longtu-index.json');
  await writeFile(indexPath, JSON.stringify({ entries: [
    { path: acceptedPath, score: 0.59 },
    { path: rejectedPath, score: 0.61 },
  ] }));
  const store = new MemeStore([emotionDirectory], {
    longtuIndexPath: indexPath,
    longtuSourceDirectory: emotionDirectory,
    longtuMaxScore: 0.6,
  });

  assert.equal((await store.getStats()).longtuImageCount, 1);
  assert.equal((await store.pick('longtu')).sourcePath, acceptedPath);
  await assert.rejects(store.pick('general'), /只允许选择龙图/);
});

test('优先使用仓库内已校准龙图，无需读取本机绝对路径索引', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wecom-meme-bot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundledDirectory = path.join(root, 'memes', 'longtu');
  await mkdir(bundledDirectory, { recursive: true });
  const bundledPath = path.join(bundledDirectory, 'bundled.png');
  await writeFile(bundledPath, await createBuiltInMeme());

  const store = new MemeStore([bundledDirectory], {
    trustedLongtuDirectory: bundledDirectory,
    longtuIndexPath: path.join(root, 'missing-index.json'),
  });
  const stats = await store.getStats();
  const meme = await store.pick('longtu');

  assert.equal(stats.imageCount, 1);
  assert.equal(stats.longtuImageCount, 1);
  assert.equal(meme.sourcePath, bundledPath);
});

test('仓库 manifest 是强制白名单，目录中的残留坏图不会被选择', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wecom-meme-bot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundledDirectory = path.join(root, 'memes', 'longtu');
  await mkdir(bundledDirectory, { recursive: true });
  const approvedBuffer = Buffer.from('89504e470d0a1a0a31', 'hex');
  const rejectedBuffer = Buffer.from('89504e470d0a1a0a32', 'hex');
  const approvedPath = path.join(bundledDirectory, 'approved.png');
  await Promise.all([
    writeFile(approvedPath, approvedBuffer),
    writeFile(path.join(bundledDirectory, 'rejected.png'), rejectedBuffer),
  ]);
  await writeFile(path.join(bundledDirectory, 'manifest.json'), JSON.stringify({
    files: [{
      filename: 'approved.png',
      sha256: createHash('sha256').update(approvedBuffer).digest('hex'),
      score: 0.1,
    }],
  }));

  const store = new MemeStore([bundledDirectory], {
    trustedLongtuDirectory: bundledDirectory,
    longtuIndexPath: path.join(root, 'missing-index.json'),
  });
  const stats = await store.getStats();
  const meme = await store.pick('longtu');

  assert.equal(stats.imageCount, 2);
  assert.equal(stats.longtuImageCount, 1);
  assert.equal(meme.sourcePath, approvedPath);
});

test('仓库 manifest 为空时关闭龙图库，不回退到未审核索引', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wecom-meme-bot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundledDirectory = path.join(root, 'memes', 'longtu');
  const emotionDirectory = path.join(root, 'Emotion');
  await Promise.all([
    mkdir(bundledDirectory, { recursive: true }),
    mkdir(emotionDirectory, { recursive: true }),
  ]);
  await writeFile(path.join(bundledDirectory, 'manifest.json'), JSON.stringify({ files: [] }));
  const cachePath = path.join(emotionDirectory, 'unreviewed.png');
  await writeFile(cachePath, Buffer.from('89504e470d0a1a0a33', 'hex'));
  const indexPath = path.join(root, 'longtu-index.json');
  await writeFile(indexPath, JSON.stringify({ entries: [{ path: cachePath, score: 0.1 }] }));

  const store = new MemeStore([bundledDirectory], {
    trustedLongtuDirectory: bundledDirectory,
    longtuIndexPath: indexPath,
    longtuSourceDirectory: emotionDirectory,
  });

  assert.equal((await store.getStats()).longtuImageCount, 0);
  await assert.rejects(store.pick('longtu'), /龙图候选集为空/);
});

test('场景关键词可从多个哈希候选中按子池选择图片', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wecom-meme-bot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundledDirectory = path.join(root, 'memes', 'longtu');
  await mkdir(bundledDirectory, { recursive: true });
  const buffers = [
    Buffer.from('89504e470d0a1a0a41', 'hex'),
    Buffer.from('89504e470d0a1a0a42', 'hex'),
    Buffer.from('89504e470d0a1a0a43', 'hex'),
  ];
  const files = [];
  for (const [index, buffer] of buffers.entries()) {
    const filename = `${index}.png`;
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    await writeFile(path.join(bundledDirectory, filename), buffer);
    files.push({ filename, sha256, score: 0.1 });
  }
  await writeFile(
    path.join(bundledDirectory, 'manifest.json'),
    JSON.stringify({ files }),
  );
  const selectedPools = [];
  const store = new MemeStore([bundledDirectory], {
    trustedLongtuDirectory: bundledDirectory,
    longtuLibrary: {
      isBlocked: () => false,
      async pickCandidate(candidates) {
        selectedPools.push(candidates.map((candidate) => candidate.sha256));
        return candidates.at(-1);
      },
    },
  });
  const meme = await store.pickByShas([files[0].sha256, files[2].sha256]);

  assert.deepEqual(selectedPools[0].sort(), [files[0].sha256, files[2].sha256].sort());
  assert.equal(meme.sha256, files[2].sha256);
});
