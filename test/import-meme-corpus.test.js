import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);

function runImport(args) {
  return execFileSync(process.execPath, ['scripts/import-meme-corpus.mjs', ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

test('importer converts and filters PTT while preserving internet-style replies', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'meme-import-test-'));
  const pttPath = path.join(directory, 'ptt.csv');
  const databasePath = path.join(directory, 'corpus.sqlite');
  writeFileSync(pttPath, [
    'question,answer',
    '"這工作也太難了吧","哪份工作不難，你問最不難的比較快。"',
    '"加我微信","https://example.com"',
    '"這是什麼新聞","习近平今天又上新闻了"',
  ].join('\n'), 'utf8');
  try {
    const output = runImport([
      '--only', 'ptt_style',
      '--ptt-file', pttPath,
      '--database', databasePath,
    ]);
    assert.match(output, /ptt_style: 1 chunks/);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare('SELECT text, terms, metadata_json FROM meme_corpus_chunks').get();
      assert.match(row.text, /这工作也太难了吧/);
      assert.match(row.text, /哪份工作不难/);
      assert.equal(row.metadata_json.includes('ptt-gossiping'), true);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM meme_corpus_chunks').get().count, 1);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('importer reads have-meme SQLite and drops bad joke labels', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'have-meme-import-test-'));
  const sourcePath = path.join(directory, 'meme.db');
  const databasePath = path.join(directory, 'corpus.sqlite');
  const source = new DatabaseSync(sourcePath);
  source.exec('CREATE TABLE memes (id INTEGER PRIMARY KEY, kind TEXT, text TEXT, aux TEXT, label TEXT, source TEXT)');
  source.prepare('INSERT INTO memes(kind,text,aux,label,source) VALUES(?,?,?,?,?)')
    .run('joke', '知识已经打包，但你的大脑不会握手。', '', 'good', 'chumor');
  source.prepare('INSERT INTO memes(kind,text,aux,label,source) VALUES(?,?,?,?,?)')
    .run('joke', '低质量笑话', '', 'bad', 'chumor');
  source.close();
  try {
    const output = runImport([
      '--only', 'have_meme',
      '--have-meme-db', sourcePath,
      '--database', databasePath,
    ]);
    assert.match(output, /have_meme: 1 chunks/);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare('SELECT text, metadata_json FROM meme_corpus_chunks').get();
      assert.match(row.text, /表达参考/);
      assert.match(row.text, /大脑不会握手/);
      assert.match(row.metadata_json, /have-meme/);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
