import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { LongtuLibrary } from '../src/longtu-library.js';
import {
  matchLongtuAliasRequest,
  parseLongtuManagementCommand,
} from '../src/longtu-management.js';

async function imageBuffer(color) {
  const image = new Jimp({ width: 32, height: 32, color });
  return image.getBuffer('image/png');
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'longtu-library-test-'));
  const builtInDirectory = path.join(root, 'built-in');
  const assetsDirectory = path.join(root, 'dynamic', 'assets');
  await Promise.all([
    mkdir(builtInDirectory, { recursive: true }),
    mkdir(assetsDirectory, { recursive: true }),
  ]);
  const candidates = [];
  for (const [index, color] of [0xff0000ff, 0x00ff00ff, 0x0000ffff].entries()) {
    const buffer = await imageBuffer(color);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const filePath = path.join(builtInDirectory, `${index}.png`);
    await writeFile(filePath, buffer);
    candidates.push({ path: filePath, sha256, extension: '.png' });
  }
  return {
    root,
    assetsDirectory,
    databaseFilePath: path.join(root, 'dynamic', 'library.sqlite'),
    candidates,
  };
}

test('持久化洗牌袋在抽完整个会话池前不会重复', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const first = new LongtuLibrary(fixture);
  await first.load();
  const selected = [];
  for (let index = 0; index < fixture.candidates.length; index += 1) {
    selected.push((await first.pickCandidate(fixture.candidates, { scope: 'qq:group:g1' })).sha256);
  }
  assert.equal(new Set(selected).size, fixture.candidates.length);
  first.close();

  const reopened = new LongtuLibrary(fixture);
  await reopened.load();
  const next = await reopened.pickCandidate(fixture.candidates, { scope: 'qq:group:g1' });
  assert.ok(fixture.candidates.some((candidate) => candidate.sha256 === next.sha256));
  assert.equal(reopened.getStats().selections, 4);
  reopened.close();
});

test('强制添加仍拦截完全重复，并支持软删除和撤销', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const library = new LongtuLibrary(fixture);
  await library.load();
  const newBuffer = await imageBuffer(0xffff00ff);
  const added = await library.reviewAndAdd(newBuffer, {
    force: true,
    actor: 'qq:admin-user',
    referenceCandidates: fixture.candidates,
  });
  assert.match(added.shortId, /^LT-[A-F0-9]{8}$/);
  assert.equal(library.getDynamicCandidates().length, 1);

  await assert.rejects(
    library.reviewAndAdd(newBuffer, {
      force: true,
      actor: 'qq:admin-user',
      referenceCandidates: fixture.candidates,
    }),
    /已经在图库/,
  );
  library.deleteBySha(added.sha256, { actor: 'qq:admin-user' });
  assert.equal(library.getDynamicCandidates().length, 0);
  assert.equal(library.isBlocked(added.sha256), true);
  const restored = library.undoDelete({ actor: 'qq:admin-user' });
  assert.equal(restored.shortId, added.shortId);
  assert.equal(library.getDynamicCandidates().length, 1);
  library.close();
});

test('解析图库聊天管理指令', () => {
  assert.deepEqual(parseLongtuManagementCommand('把这张龙图添加进图库'), {
    action: 'add', force: false, shortId: '',
  });
  assert.deepEqual(parseLongtuManagementCommand('把这个添加到图库'), {
    action: 'add', force: false, shortId: '',
  });
  assert.deepEqual(parseLongtuManagementCommand('把这张图加入图库'), {
    action: 'add', force: false, shortId: '',
  });
  assert.deepEqual(parseLongtuManagementCommand('强制添加这张龙图'), {
    action: 'add', force: true, shortId: '',
  });
  assert.equal(parseLongtuManagementCommand('删除上一张龙图').action, 'delete-previous');
  assert.equal(parseLongtuManagementCommand('删除龙图 LT-A1B2C3D4').shortId, 'LT-A1B2C3D4');
  assert.equal(parseLongtuManagementCommand('撤销删除').action, 'undo-delete');
  assert.equal(parseLongtuManagementCommand('图库状态').action, 'status');
  assert.deepEqual(parseLongtuManagementCommand('以后发赛尔号的时候就调用这张图'), {
    action: 'bind-alias', force: false, shortId: '', alias: '赛尔号',
  });
  assert.deepEqual(parseLongtuManagementCommand('强制绑定赛尔号到这张图'), {
    action: 'bind-alias', force: true, shortId: '', alias: '赛尔号',
  });
  assert.equal(parseLongtuManagementCommand('取消赛尔号绑定').action, 'unbind-alias');
  assert.equal(parseLongtuManagementCommand('别名列表').action, 'alias-status');
  assert.equal(
    matchLongtuAliasRequest('发赛尔号', [{ alias: '赛尔号', sha256: 'a'.repeat(64) }]).alias,
    '赛尔号',
  );
  assert.equal(
    matchLongtuAliasRequest('讨论一下赛尔号', [{ alias: '赛尔号', sha256: 'a'.repeat(64) }]),
    null,
  );
});

test('OCR 文字别名可持久导入，管理员绑定会覆盖且删除后不会在重启时复活', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const seedAliasesFilePath = path.join(fixture.root, 'text-aliases.json');
  await writeFile(seedAliasesFilePath, JSON.stringify({ aliases: [{
    alias: '逆天原批',
    sha256: fixture.candidates[0].sha256,
  }] }));
  const options = { ...fixture, seedAliasesFilePath };
  const library = new LongtuLibrary(options);
  await library.load();
  assert.equal(library.resolveAlias('逆天原批').source, 'ocr');
  assert.equal(library.getStats().aliases, 1);

  const bound = library.bindAlias('赛尔号', fixture.candidates[1].sha256, {
    actor: 'qq:admin-user',
  });
  assert.equal(bound.alias, '赛尔号');
  assert.equal(library.resolveAlias('赛尔号').sha256, fixture.candidates[1].sha256);
  library.unbindAlias('逆天原批', { actor: 'qq:admin-user' });
  library.close();

  const reopened = new LongtuLibrary(options);
  await reopened.load();
  assert.equal(reopened.resolveAlias('逆天原批'), null);
  assert.equal(reopened.resolveAlias('赛尔号').source, 'manual');
  reopened.close();
});
