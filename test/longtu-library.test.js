import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { DatabaseSync } from 'node:sqlite';
import { LongtuLibrary } from '../src/longtu-library.js';
import { parseTesseractTsv } from '../src/image-ocr.js';
import {
  matchLongtuAliasRequest,
  matchLongtuContextAlias,
  matchLongtuSceneAlias,
  matchLongtuSceneAliases,
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

test('Tesseract 结果只保留高置信度且适合作为场景匹配的文字', () => {
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t92\t玩',
    '5\t1\t1\t1\t1\t2\t10\t0\t20\t10\t88\t原神',
    '5\t1\t1\t1\t2\t1\t0\t20\t20\t10\t12\t错误低置信度',
    '5\t1\t1\t1\t3\t1\t0\t40\t20\t10\t90\t12345',
  ].join('\n');
  assert.deepEqual(parseTesseractTsv(tsv), ['玩原神']);
});

test('新图入库后自动 OCR 标记，没文字或识别失败时仍按普通图片保存', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const responses = [
    ['玩原神玩的', '原神启动'],
    [],
    new Error('模拟 OCR 不可用'),
  ];
  const library = new LongtuLibrary({
    ...fixture,
    ocrCommand: 'mock-tesseract',
    async ocrRecognizer() {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  });
  await library.load();

  const tagged = await library.reviewAndAdd(await imageBuffer(0xffff00ff), {
    force: true,
    actor: 'qq:admin-user',
    referenceCandidates: fixture.candidates,
  });
  const noText = await library.reviewAndAdd(await imageBuffer(0x00ffffff), {
    force: true,
    actor: 'qq:admin-user',
    referenceCandidates: fixture.candidates,
  });
  const failed = await library.reviewAndAdd(await imageBuffer(0xff00ffff), {
    force: true,
    actor: 'qq:admin-user',
    referenceCandidates: fixture.candidates,
  });

  assert.deepEqual(tagged.autoOcr, {
    status: 'tagged', aliases: ['玩原神玩的', '原神启动'],
  });
  assert.deepEqual(
    library.listAliasesBySha(tagged.sha256, { source: 'ocr' }).map((entry) => entry.alias),
    ['原神启动', '玩原神玩的'],
  );
  assert.deepEqual(noText.autoOcr, { status: 'no-text', aliases: [] });
  assert.equal(failed.autoOcr.status, 'failed');
  assert.match(failed.autoOcr.error, /模拟 OCR 不可用/);
  assert.equal(library.getDynamicCandidates().length, 3);
  library.close();
});

test('解析图库聊天管理指令', () => {
  assert.deepEqual(parseLongtuManagementCommand('/add'), {
    action: 'add', force: true, shortId: '', alias: '',
  });
  assert.deepEqual(parseLongtuManagementCommand('/tag 赛尔号'), {
    action: 'bind-alias', force: true, shortId: '', alias: '赛尔号',
  });
  assert.deepEqual(parseLongtuManagementCommand('/tag 钱'), {
    action: 'bind-alias', force: true, shortId: '', alias: '钱',
  });
  assert.equal(parseLongtuManagementCommand('/tag').action, 'invalid-slash');
  assert.equal(parseLongtuManagementCommand('/del invalid-id').action, 'invalid-slash');
  assert.deepEqual(parseLongtuManagementCommand('/del'), {
    action: 'delete-this', force: false, shortId: '', alias: '',
  });
  assert.deepEqual(parseLongtuManagementCommand('/del lt-a1b2c3d4'), {
    action: 'delete-this', force: false, shortId: 'LT-A1B2C3D4', alias: '',
  });
  assert.equal(parseLongtuManagementCommand('/help').action, 'ignored-slash');
  assert.equal(parseLongtuManagementCommand('把这张龙图添加进图库'), null);
  assert.equal(parseLongtuManagementCommand('图片标记赛尔号'), null);
  assert.equal(parseLongtuManagementCommand('删除上一张龙图'), null);
  assert.equal(parseLongtuManagementCommand('撤销删除').action, 'undo-delete');
  assert.equal(parseLongtuManagementCommand('图库状态').action, 'status');
  assert.equal(parseLongtuManagementCommand('取消赛尔号绑定').action, 'unbind-alias');
  assert.deepEqual(parseLongtuManagementCommand('取消这张图的原神标记'), {
    action: 'unbind-image-alias', force: false, shortId: '', alias: '原神',
  });
  assert.equal(parseLongtuManagementCommand('别名列表').action, 'alias-status');
  assert.equal(parseLongtuManagementCommand('标记列表').action, 'alias-status');
  assert.equal(parseLongtuManagementCommand('图库标记列表').action, 'alias-status');
  assert.deepEqual(parseLongtuManagementCommand('检查这张图'), {
    action: 'inspect-image', force: false, shortId: '', alias: '',
  });
  assert.deepEqual(parseLongtuManagementCommand('这张图标记了什么'), {
    action: 'inspect-image', force: false, shortId: '', alias: '',
  });
  assert.deepEqual(parseLongtuManagementCommand('检查标记耄耋'), {
    action: 'inspect-alias', force: false, shortId: '', alias: '耄耋',
  });
  assert.equal(
    matchLongtuAliasRequest('发赛尔号', [{ alias: '赛尔号', sha256: 'a'.repeat(64) }]).alias,
    '赛尔号',
  );
  assert.equal(
    matchLongtuSceneAlias(
      '帮我骂一下赛尔号',
      '赛尔号这种场景就该被钉在龙图墙上',
      [{ alias: '赛尔号', sha256: 'b'.repeat(64), source: 'ocr' }],
    ).sha256,
    'b'.repeat(64),
  );
  assert.equal(
    matchLongtuSceneAlias(
      '随便聊聊',
      '好的，收到',
      [{ alias: '好的', sha256: 'c'.repeat(64), source: 'ocr' }],
    ),
    null,
  );
  assert.equal(
    matchLongtuSceneAlias(
      '玩原神玩的',
      '确实有点像玩原神玩的',
      [{
        alias: '大伙还能认为你是玩原神玩的',
        sha256: 'd'.repeat(64),
        source: 'ocr',
      }],
    ).sha256,
    'd'.repeat(64),
  );
  assert.equal(
    matchLongtuSceneAlias(
      '原神',
      '要不先休息一下',
      [{
        alias: '在登录原神的那一刻起我才感受到生命的意义',
        sha256: 'e'.repeat(64),
        source: 'ocr',
      }],
    ).sha256,
    'e'.repeat(64),
  );
  assert.deepEqual(
    matchLongtuSceneAliases(
      '原神原神原神',
      '确实是原神玩家',
      [
        { alias: '玩原神玩的', sha256: '1'.repeat(64), source: 'ocr' },
        { alias: '在被窝里玩原神吗', sha256: '2'.repeat(64), source: 'ocr' },
        { alias: '原神启动', sha256: '3'.repeat(64), source: 'ocr' },
        { alias: '无关图片', sha256: '4'.repeat(64), source: 'ocr' },
      ],
    ).map((entry) => entry.sha256).sort(),
    ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)],
  );
  assert.equal(
    matchLongtuAliasRequest('发在登录原神的那一刻起我才感受到生命的意义', [{
      alias: '在登录原神的那一刻起我才感受到生命的意义',
      sha256: 'f'.repeat(64),
      source: 'ocr',
    }]),
    null,
  );
  assert.equal(
    matchLongtuAliasRequest('讨论一下赛尔号', [{ alias: '赛尔号', sha256: 'a'.repeat(64) }]),
    null,
  );
  assert.equal(
    matchLongtuContextAlias('辱骂一下赛尔号', [{
      alias: '赛尔号', sha256: 'a'.repeat(64), source: 'manual',
    }]).alias,
    '赛尔号',
  );
  assert.equal(
    matchLongtuContextAlias('辱骂一下赛尔号', [{
      alias: '赛尔号', sha256: 'a'.repeat(64), source: 'ocr',
    }]),
    null,
  );
});

test('管理员关键词支持一对多图片池，同图也能进入多个池并持久保存', async (t) => {
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

  const first = library.bindAlias('赛尔号', fixture.candidates[0].sha256, {
    actor: 'qq:admin-user',
  });
  const second = library.bindAlias('赛尔号', fixture.candidates[1].sha256, {
    actor: 'qq:admin-user',
  });
  library.bindAlias('钱', fixture.candidates[1].sha256, {
    actor: 'qq:admin-user',
  });
  assert.equal(first.poolSize, 1);
  assert.equal(second.poolSize, 2);
  assert.deepEqual(
    library.resolveAliases('赛尔号', { source: 'manual' }).map((entry) => entry.sha256),
    [fixture.candidates[0].sha256, fixture.candidates[1].sha256],
  );
  assert.deepEqual(
    matchLongtuAliasRequest('发赛尔号', library.listAliases()).sha256s,
    [fixture.candidates[0].sha256, fixture.candidates[1].sha256],
  );
  assert.deepEqual(
    library.listAliasesBySha(fixture.candidates[1].sha256, { source: 'manual' })
      .map((entry) => entry.alias),
    ['钱', '赛尔号'],
  );
  const removed = library.unbindAlias('赛尔号', {
    actor: 'qq:admin-user',
    sha256: fixture.candidates[0].sha256,
  });
  assert.equal(removed.poolSize, 1);
  library.close();

  const reopened = new LongtuLibrary(options);
  await reopened.load();
  assert.equal(reopened.resolveAlias('逆天原批').source, 'ocr');
  assert.equal(reopened.resolveAlias('钱').source, 'manual');
  assert.deepEqual(
    reopened.resolveAliases('赛尔号', { source: 'manual' }).map((entry) => entry.sha256),
    [fixture.candidates[1].sha256],
  );
  assert.equal(reopened.getStats().manualAliases, 2);
  assert.equal(reopened.getStats().manualAliasBindings, 2);
  reopened.close();
});

test('旧版单主键关键词表会无损迁移为关键词图片池', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const legacy = new DatabaseSync(fixture.databaseFilePath);
  legacy.exec(`
    CREATE TABLE longtu_aliases (
      alias TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      source TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      deleted_by TEXT
    );
  `);
  legacy.prepare(`
    INSERT INTO longtu_aliases(
      alias, sha256, source, created_by, created_at, updated_at,
      deleted_at, deleted_by
    ) VALUES (?, ?, 'manual', 'qq:admin-user', 1, 1, NULL, NULL)
  `).run('原神', fixture.candidates[0].sha256);
  legacy.close();

  const library = new LongtuLibrary(fixture);
  await library.load();
  library.bindAlias('原神', fixture.candidates[1].sha256, { actor: 'qq:admin-user' });
  assert.deepEqual(
    library.resolveAliases('原神', { source: 'manual' }).map((entry) => entry.sha256),
    [fixture.candidates[0].sha256, fixture.candidates[1].sha256],
  );
  library.close();
});
