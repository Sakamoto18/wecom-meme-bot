import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import OpenCC from 'opencc-js';
import { MEME_CORPUS_META, MemeCorpusStore } from '../src/meme-corpus.js';

const NOOBLOCK_REPO = 'NooBlock/astrbot-rag-kb';
const NOOBLOCK_BRANCH = 'main';
const MEMEWIKI_REPO = 'in1t1a1/astrbot_plugin_memewiki';
const MEMEWIKI_BRANCH = 'main';
const PTT_REPO = 'zake7749/Gossiping-Chinese-Corpus';
const PTT_BRANCH = 'master';
const PTT_FILE = 'data/Gossiping-QA-Dataset-2_0.csv';
const NOOBLOCK_CORPORA = {
  cheer_terms: '01_cheer_terms',
  meme_style: '02_meme_style',
  ruozhiba: '03_ruozhiba',
  vbar: '04_vbar',
  hell: '05_hell',
};

const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' });
const PTT_URL_PATTERN = /(?:https?:\/\/|www\.|bit\.ly|tinyurl\.)/iu;
const PTT_CONTACT_PATTERN = /(?:加(?:我|微信|line|qq)|微信号|聯絡|聯繫|粉絲專頁|二维码|電話|手机号|手機號|邮箱|郵箱|私訊|私信)/iu;
const PTT_AD_PATTERN = /(?:代購|刷單|返利|優惠券|折扣碼|招募|徵才|出租|出售|賣場|賺錢|投資群|貸款|抽獎)/iu;
const PTT_POLITICAL_NAME_PATTERN = /(?:毛泽东|毛澤東|邓小平|鄧小平|华国锋|華國鋒|江泽民|江澤民|胡锦涛|胡錦濤|习近平|習近平|Mao\s+Zedong|Deng\s+Xiaoping|Jiang\s+Zemin|Hu\s+Jintao|Xi\s+Jinping)/iu;
const PTT_LOW_VALUE_PATTERN = /^(?:沒有資料|無資料|推|幫高調|同意|\+1|笑死|哈哈哈|X{2,}|[.。!?！？\s]+)$/iu;
const DEFAULT_PTT_SAMPLE_STRIDE = 4;

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

function* parseDelimited(text, delimiter = ',') {
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && character === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      field = '';
      if (row.some((value) => String(value).trim())) yield row;
      row = [];
      continue;
    }
    field += character;
  }
  if (field || row.length) {
    row.push(field);
    if (row.some((value) => String(value).trim())) yield row;
  }
}

function normalizedText(value, limit = 1_800) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
}

function normalizedKey(value) {
  return normalizedText(toSimplified(value), 500)
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, '');
}

function pttPairFilter(question, answer) {
  const q = normalizedText(toSimplified(question), 180);
  const a = normalizedText(toSimplified(answer), 260);
  const combined = `${q} ${a}`;
  if (q.length < 3 || a.length < 2) return { keep: false, reason: 'too-short' };
  if (PTT_LOW_VALUE_PATTERN.test(a)) return { keep: false, reason: 'low-value' };
  if (PTT_URL_PATTERN.test(combined)) return { keep: false, reason: 'url' };
  if (PTT_CONTACT_PATTERN.test(combined)) return { keep: false, reason: 'contact' };
  if (PTT_AD_PATTERN.test(combined)) return { keep: false, reason: 'advertising' };
  if (PTT_POLITICAL_NAME_PATTERN.test(combined)) return { keep: false, reason: 'protected-politics' };
  if ((combined.match(/[!?！？。]{4,}/gu) ?? []).length > 2) return { keep: false, reason: 'punctuation-noise' };
  if (/(.)\1{8,}/u.test(combined)) return { keep: false, reason: 'repeated-noise' };
  return { keep: true, question: q, answer: a };
}

function pttChunks(text, sampleStride = DEFAULT_PTT_SAMPLE_STRIDE) {
  const rows = parseDelimited(text);
  const first = rows.next();
  if (first.done) return { chunks: [], stats: { input: 0, kept: 0, dropped: {} } };
  const headers = first.value.map((value) => normalizedKey(value));
  const questionIndex = headers.findIndex((value) => /question|問題|问题/u.test(value));
  const answerIndex = headers.findIndex((value) => /answer|回答|答案/u.test(value));
  const qIndex = questionIndex >= 0 ? questionIndex : 0;
  const aIndex = answerIndex >= 0 ? answerIndex : 1;
  const dropped = {};
  const seen = new Set();
  const stats = { input: 0, kept: 0, dropped };
  const hasHeader = questionIndex >= 0 || answerIndex >= 0;
  function* chunks() {
    const dataRows = hasHeader ? rows : (function* firstAndRest() {
      yield first.value;
      yield* rows;
    }());
    let index = 0;
    for (const row of dataRows) {
      const rowIndex = index;
      index += 1;
      stats.input += 1;
      const result = pttPairFilter(row[qIndex], row[aIndex]);
      if (!result.keep) {
        dropped[result.reason] = (dropped[result.reason] ?? 0) + 1;
        continue;
      }
      const key = `${normalizedKey(result.question)}\u0000${normalizedKey(result.answer)}`;
      if (seen.has(key)) {
        dropped.duplicate = (dropped.duplicate ?? 0) + 1;
        continue;
      }
      if (sampleStride > 1 && rowIndex % sampleStride !== 0) {
        dropped.sampled = (dropped.sampled ?? 0) + 1;
        continue;
      }
      seen.add(key);
      stats.kept += 1;
      yield {
        id: rowIndex + 1,
        text: `对话：\n用户：${result.question}\n回复：${result.answer}`,
        terms: result.question,
        metadata: { sourceKind: 'ptt-gossiping', question: result.question },
      };
    }
  }
  return { chunks: chunks(), stats };
}

function haveMemeChunks(databaseFilePath) {
  const database = new DatabaseSync(databaseFilePath, { readOnly: true });
  try {
    const columns = new Set(database.prepare('PRAGMA table_info(memes)').all().map((row) => String(row.name)));
    if (!columns.has('kind') || !columns.has('text')) {
      throw new Error('have-meme 数据库缺少 memes.kind 或 memes.text');
    }
    const selected = ['kind', 'text', 'aux', 'label', 'source'].filter((name) => columns.has(name));
    const rows = database.prepare(`SELECT ${selected.join(', ')} FROM memes ORDER BY id`).all();
    return rows.flatMap((row, index) => {
      const text = normalizedText(toSimplified(row.text), 1_200);
      if (text.length < 4 || row.label === 'bad' || PTT_POLITICAL_NAME_PATTERN.test(text)) return [];
      return [{
        id: index + 1,
        text: `表达参考：${text}`,
        terms: text,
        metadata: {
          sourceKind: 'have-meme',
          kind: normalizedText(row.kind, 40),
          auxiliary: normalizedText(row.aux, 300),
          source: normalizedText(row.source, 200),
        },
      }];
    });
  } finally {
    database.close();
  }
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
    : ['memewiki', ...Object.keys(NOOBLOCK_CORPORA), 'have_meme', 'ptt_style'];
  const supported = new Set(['memewiki', ...Object.keys(NOOBLOCK_CORPORA), 'have_meme', 'ptt_style']);
  const unsupported = selected.filter((key) => !supported.has(key));
  if (unsupported.length) {
    throw new Error(`未知语料库：${unsupported.join(', ')}`);
  }

  const store = new MemeCorpusStore({
    databaseFilePath,
    enabledCorpora: Object.keys(MEME_CORPUS_META),
    includeSensitive: true,
  });
  const nooblockSource = argValue('--source', '');
  const haveMemeDatabasePath = path.resolve(
    argValue('--have-meme-db', process.env.HAVE_MEME_DB || 'data/have-meme/meme.db'),
  );
  const pttFilePath = argValue('--ptt-file', process.env.PTT_CORPUS_FILE || '');
  const pttSampleStride = Math.max(
    1,
    Number(argValue('--ptt-sample-stride', process.env.PTT_CORPUS_SAMPLE_STRIDE || DEFAULT_PTT_SAMPLE_STRIDE)) || DEFAULT_PTT_SAMPLE_STRIDE,
  );
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
    if (selected.includes('have_meme')) {
      if (!existsSync(haveMemeDatabasePath)) {
        console.warn(`have_meme: 跳过，找不到数据库 ${haveMemeDatabasePath}`);
      } else {
        const chunks = haveMemeChunks(haveMemeDatabasePath);
        const count = store.replaceCorpus('have_meme', chunks, {
          sourceUrl: `local:${haveMemeDatabasePath}`,
          license: 'Mixed upstream licenses; personal self-use only',
        });
        console.log(`have_meme: ${count} chunks`);
      }
    }
    if (selected.includes('ptt_style')) {
      const sourceUrl = `https://raw.githubusercontent.com/${PTT_REPO}/${PTT_BRANCH}/${PTT_FILE}`;
      const text = pttFilePath
        ? readFileSync(path.resolve(pttFilePath), 'utf8')
        : await fetchText(sourceUrl);
      const parsed = pttChunks(text, pttSampleStride);
      const count = store.replaceCorpus('ptt_style', parsed.chunks, {
        sourceUrl: pttFilePath ? `local:${path.resolve(pttFilePath)}` : sourceUrl,
        license: 'Apache-2.0 repository; source data for personal self-use only',
      });
      console.log(`ptt_style: ${count} chunks; sample_stride=${pttSampleStride}; filter=${JSON.stringify(parsed.stats)}`);
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
