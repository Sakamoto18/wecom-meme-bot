import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { MEME_CORPUS_META, MemeCorpusStore } from '../src/meme-corpus.js';

const NOOBLOCK_REPO = 'NooBlock/astrbot-rag-kb';
const NOOBLOCK_BRANCH = 'main';
const MEMEWIKI_REPO = 'in1t1a1/astrbot_plugin_memewiki';
const MEMEWIKI_BRANCH = 'main';
const NOOBLOCK_CORPORA = {
  cheer_terms: '01_cheer_terms',
  meme_style: '02_meme_style',
  ruozhiba: '03_ruozhiba',
  vbar: '04_vbar',
  hell: '05_hell',
};

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? '') : fallback;
}

function parseJsonl(text) {
  return String(text ?? '').split('\n').flatMap((line) => {
    const value = line.trim();
    if (!value) return [];
    try {
      const row = JSON.parse(value);
      return row?.text ? [row] : [];
    } catch {
      return [];
    }
  });
}

function splitCorpusChunks(corpus, chunks) {
  if (corpus === 'meme_style') {
    return chunks.flatMap((chunk) => String(chunk.text ?? '')
      .split(/\n{2,}/u)
      .map((text) => text.trim())
      .filter((text) => text.includes('用户：') && text.includes('回复：')));
  }
  if (corpus === 'ruozhiba') {
    return chunks.flatMap((chunk) => String(chunk.text ?? '')
      .split('\n')
      .map((line) => line.replace(/^\s*\d+[.、]\s*/u, '').trim())
      .filter((line) => line.length >= 8 && !/^弱智吧神提问/u.test(line)));
  }
  return chunks.map((chunk) => String(chunk.text ?? '').trim()).filter(Boolean);
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'wecom-meme-bot-corpus-import' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.text();
}

async function fetchBuffer(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'wecom-meme-bot-corpus-import' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function checkoutNooblock() {
  const temp = mkdtempSync(path.join(tmpdir(), 'meme-corpus-'));
  const target = path.join(temp, 'repo');
  execFileSync('git', ['clone', '--depth', '1', `https://github.com/${NOOBLOCK_REPO}.git`, target], {
    stdio: 'inherit',
  });
  return { root: target, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

function memewikiChunks(databaseFilePath) {
  const database = new DatabaseSync(databaseFilePath);
  try {
    const columns = new Set(
      database.prepare('PRAGMA table_info(memes)').all().map((row) => String(row.name)),
    );
    if (!columns.has('title')) throw new Error('memewiki 数据库缺少 memes.title');
    const selected = ['title', 'tags', 'usage', 'origin', 'other', 'summary']
      .filter((name) => columns.has(name));
    const rows = database.prepare(`SELECT ${selected.join(', ')} FROM memes ORDER BY title`).all();
    return rows.map((row, index) => {
      const sections = [
        `【词条】${String(row.title ?? '').trim()}`,
        row.tags ? `【标签】${String(row.tags).trim()}` : '',
        row.usage ? `【用法】${String(row.usage).trim()}` : '',
        row.origin ? `【出处】${String(row.origin).trim()}` : '',
        row.other ? `【补充】${String(row.other).trim()}` : '',
        row.summary ? `【摘要】${String(row.summary).trim()}` : '',
      ].filter(Boolean);
      return { id: index + 1, text: sections.join('\n') };
    }).filter((row) => row.text.length >= 4);
  } finally {
    database.close();
  }
}

async function loadMemewiki(options = {}) {
  if (options.localPath) {
    const databaseFilePath = path.resolve(options.localPath);
    if (!existsSync(databaseFilePath)) throw new Error(`找不到 memewiki 数据库：${databaseFilePath}`);
    return {
      chunks: memewikiChunks(databaseFilePath),
      sourceUrl: `local:${databaseFilePath}`,
      license: 'MIT (code); data from cnmeme.wiki',
      cleanup: () => {},
    };
  }
  const temp = mkdtempSync(path.join(tmpdir(), 'meme-wiki-'));
  const databaseFilePath = path.join(temp, 'memes.db');
  const url = `https://raw.githubusercontent.com/${MEMEWIKI_REPO}/${MEMEWIKI_BRANCH}/data/memes.db`;
  writeFileSync(databaseFilePath, await fetchBuffer(url));
  return {
    chunks: memewikiChunks(databaseFilePath),
    sourceUrl: url,
    license: 'MIT (code); data from cnmeme.wiki',
    cleanup: () => rmSync(temp, { recursive: true, force: true }),
  };
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const databaseFilePath = path.resolve(
    projectRoot,
    argValue('--database', process.env.QQ_MEME_CORPUS_DATABASE_FILE || 'data/qq-meme-corpus.sqlite'),
  );
  const requested = argValue('--only', '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const selected = requested.length
    ? requested
    : ['memewiki', ...Object.keys(NOOBLOCK_CORPORA)];
  const unknown = selected.filter((key) => key !== 'memewiki' && !NOOBLOCK_CORPORA[key]);
  if (unknown.length) throw new Error(`未知语料库：${unknown.join(', ')}`);

  const store = new MemeCorpusStore({
    databaseFilePath,
    enabledCorpora: Object.keys(MEME_CORPUS_META),
    includeSensitive: true,
  });
  const nooblockSource = argValue('--source', '');
  const localNooblockRoot = nooblockSource ? path.resolve(nooblockSource) : '';
  const checkout = localNooblockRoot || !selected.some((key) => NOOBLOCK_CORPORA[key])
    ? null
    : checkoutNooblock();
  const nooblockRoot = localNooblockRoot || checkout?.root || '';
  let memewikiImport = null;

  try {
    if (selected.includes('memewiki')) {
      memewikiImport = await loadMemewiki({ localPath: argValue('--memewiki-db', '') });
      const count = store.replaceCorpus('memewiki', memewikiImport.chunks, {
        sourceUrl: memewikiImport.sourceUrl,
        license: memewikiImport.license,
      });
      console.log(`memewiki: ${count} chunks`);
    }
    for (const key of selected.filter((item) => NOOBLOCK_CORPORA[item])) {
      const directory = NOOBLOCK_CORPORA[key];
      const sourceUrl = `https://raw.githubusercontent.com/${NOOBLOCK_REPO}/${NOOBLOCK_BRANCH}/corpora/${directory}/chunks.jsonl`;
      const text = nooblockRoot
        ? readFileSync(path.join(nooblockRoot, 'corpora', directory, 'chunks.jsonl'), 'utf8')
        : await fetchText(sourceUrl);
      const chunks = splitCorpusChunks(key, parseJsonl(text))
        .map((value, index) => ({ id: index + 1, text: value }));
      const count = store.replaceCorpus(key, chunks, {
        sourceUrl,
        license: 'Third-party corpus; personal self-use only',
      });
      console.log(`${key}: ${count} chunks`);
    }
    console.log(JSON.stringify({
      database: databaseFilePath,
      stats: store.getStats(),
      hint: '本地数据不入库；需要重新导入时重跑 npm run import:meme-corpus',
    }, null, 2));
  } finally {
    store.close();
    checkout?.cleanup?.();
    memewikiImport?.cleanup?.();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
