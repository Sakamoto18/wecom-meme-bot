import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CORPUS_META = Object.freeze({
  memewiki: { label: '梗百科词条', kind: 'definition', priority: 0 },
  cheer_terms: { label: '网络流行语释义', kind: 'definition', priority: 1 },
  meme_style: { label: '网梗对话风格', kind: 'style', priority: 2 },
  ruozhiba: { label: '弱智吧风格', kind: 'style', priority: 3 },
  vbar: { label: 'V吧黑话', kind: 'definition', priority: -1 },
  hell: { label: '地狱笑话', kind: 'style', priority: -1, sensitive: true },
});

const DEFAULT_CORPORA = Object.freeze(['memewiki', 'cheer_terms', 'meme_style', 'ruozhiba']);
const MAX_CHUNK = 1_800;
const MAX_DEFINITION = 420;
const MAX_STYLE = 280;
const MAX_PROMPT = 1_000;
const STOP_GRAMS = new Set([
  '是什么', '什么梗', '啥意思', '什么意思', '么意思', '什么意',
  '怎么回', '怎么接', '怎么用', '这个梗', '梗是什', '是什么梗',
  '网络用', '络用语', '黑话', '出处是', '来源是',
]);

function normalized(value, limit = MAX_CHUNK) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
}

function corpusKey(value) {
  const key = normalized(value, 40).toLowerCase();
  return CORPUS_META[key] ? key : '';
}

function tokenCandidates(value) {
  const source = normalized(value, 1_200).toLowerCase();
  return [...new Set([
    ...(source.match(/[\p{Script=Han}]{2,}/gu) ?? []),
    ...(source.match(/[a-z][a-z0-9_-]{1,}/giu) ?? []),
  ])].slice(0, 12);
}

function queryTokens(value) {
  const candidates = tokenCandidates(value);
  const preferred = candidates.filter((token) => token.length <= 12);
  return (preferred.length ? preferred : candidates).slice(0, 6);
}

function trigramCandidates(value) {
  const source = normalized(value, 800);
  const tokens = queryTokens(source);
  const grams = tokens.flatMap((token) => {
    if (token.length === 3) return [token];
    if (token.length > 3) {
      const values = [];
      for (let index = 0; index <= token.length - 3; index += 1) {
        values.push(token.slice(index, index + 3));
      }
      return values.slice(0, 10);
    }
    return [];
  });
  if (grams.length) {
    const meaningful = [...new Set(grams)].filter((gram) => !STOP_GRAMS.has(gram));
    return (meaningful.length ? meaningful : [...new Set(grams)]).slice(0, 8);
  }
  return source.length >= 3 ? [source.slice(0, 40)] : [];
}

function extractTerms(text, corpus) {
  const value = normalized(text, MAX_CHUNK);
  const bracket = value.match(/【词条】\s*([^【\n]{2,40})/u)?.[1];
  if (bracket) return normalized(bracket, 60);
  if (corpus === 'memewiki' || corpus === 'cheer_terms') {
    const firstLine = value.split(/[。！？!?\n]/u)[0];
    return normalized(firstLine, 80);
  }
  return '';
}

function definitionRelevant(row, query) {
  const terms = normalized(row?.terms, 120).toLowerCase();
  if (!terms) return false;
  const source = normalized(query, 400).toLowerCase();
  if (source.includes(terms)) return true;
  const tokens = queryTokens(source).filter((token) => token.length >= 2);
  return tokens.some((token) => terms.includes(token) || token.includes(terms));
}

export class MemeCorpusStore {
  constructor(options = {}) {
    this.databaseFilePath = normalized(options.databaseFilePath, 500);
    const requested = Array.isArray(options.enabledCorpora) && options.enabledCorpora.length
      ? options.enabledCorpora
      : DEFAULT_CORPORA;
    this.enabledCorpora = [...new Set(requested.map(corpusKey).filter(Boolean))];
    this.includeSensitive = options.includeSensitive === true;
    this.database = null;
  }

  ensureOpen() {
    if (this.database) return this.database;
    if (!this.databaseFilePath) throw new Error('中文互联网语料库路径不能为空');
    mkdirSync(path.dirname(this.databaseFilePath), { recursive: true });
    this.database = new DatabaseSync(this.databaseFilePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meme_corpus_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        corpus TEXT NOT NULL,
        external_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        terms TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        imported_at INTEGER NOT NULL,
        UNIQUE(corpus, external_id)
      );
      CREATE INDEX IF NOT EXISTS meme_corpus_chunks_corpus ON meme_corpus_chunks(corpus);
      CREATE VIRTUAL TABLE IF NOT EXISTS meme_corpus_fts USING fts5(
        text,
        terms,
        tokenize='trigram'
      );
      CREATE TABLE IF NOT EXISTS meme_corpus_manifest (
        corpus TEXT PRIMARY KEY,
        source_url TEXT NOT NULL DEFAULT '',
        license TEXT NOT NULL DEFAULT '',
        chunk_count INTEGER NOT NULL DEFAULT 0,
        imported_at INTEGER NOT NULL
      );
    `);
    return this.database;
  }

  replaceCorpus(corpus, chunks, options = {}) {
    const key = corpusKey(corpus);
    if (!key) throw new Error(`未知语料库：${corpus}`);
    const rows = (Array.isArray(chunks) ? chunks : []).flatMap((chunk, index) => {
      const text = normalized(chunk?.text ?? chunk, MAX_CHUNK);
      if (text.length < 4) return [];
      const externalId = Number.isFinite(Number(chunk?.id)) ? Number(chunk.id) : index;
      return [{
        externalId,
        text,
        terms: extractTerms(text, key),
        sourceUrl: normalized(options.sourceUrl, 500),
      }];
    });
    const db = this.ensureOpen();
    const now = Number(options.now) || Date.now();
    const insertChunk = db.prepare(`
      INSERT INTO meme_corpus_chunks(corpus, external_id, text, terms, source_url, imported_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(corpus, external_id) DO UPDATE SET
        text=excluded.text, terms=excluded.terms,
        source_url=excluded.source_url, imported_at=excluded.imported_at
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      const oldIds = db.prepare('SELECT id FROM meme_corpus_chunks WHERE corpus = ?').all(key);
      for (const row of oldIds) {
        db.prepare('DELETE FROM meme_corpus_fts WHERE rowid = ?').run(row.id);
      }
      db.prepare('DELETE FROM meme_corpus_chunks WHERE corpus = ?').run(key);
      for (const row of rows) {
        const info = insertChunk.run(key, row.externalId, row.text, row.terms, row.sourceUrl, now);
        const id = Number(info.lastInsertRowid);
        db.prepare('INSERT INTO meme_corpus_fts(rowid, text, terms) VALUES (?, ?, ?)')
          .run(id, row.text, row.terms);
      }
      db.prepare(`
        INSERT INTO meme_corpus_manifest(corpus, source_url, license, chunk_count, imported_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(corpus) DO UPDATE SET
          source_url=excluded.source_url, license=excluded.license,
          chunk_count=excluded.chunk_count, imported_at=excluded.imported_at
      `).run(key, normalized(options.sourceUrl, 500), normalized(options.license, 120), rows.length, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rows.length;
  }

  isAvailable() {
    try {
      const db = this.ensureOpen();
      return Number(db.prepare('SELECT COUNT(*) AS count FROM meme_corpus_chunks').get().count) > 0;
    } catch {
      return false;
    }
  }

  search(query, options = {}) {
    const source = normalized(query, 1_200);
    if (!source) return [];
    const includeSensitive = options.includeSensitive === true || this.includeSensitive;
    const requested = (Array.isArray(options.corpora) && options.corpora.length
      ? options.corpora
      : [...this.enabledCorpora, ...(includeSensitive ? ['hell'] : [])])
      .map(corpusKey).filter(Boolean);
    const allowed = requested.filter((corpus) => (
      CORPUS_META[corpus] && (!CORPUS_META[corpus].sensitive || includeSensitive)
    ));
    if (!allowed.length) return [];
    const limit = Math.max(1, Math.min(12, Number(options.limit) || 6));
    const db = this.ensureOpen();
    const placeholders = allowed.map(() => '?').join(', ');
    const found = new Map();
    const grams = trigramCandidates(source);
    if (grams.length) {
      try {
        const match = grams.map((token) => `"${token.replace(/"/gu, '""')}"`).join(' OR ');
        const rows = db.prepare(`
          SELECT c.id, c.corpus, c.text, c.terms, bm25(meme_corpus_fts) AS score
          FROM meme_corpus_fts f
          JOIN meme_corpus_chunks c ON c.id = f.rowid
          WHERE meme_corpus_fts MATCH ? AND c.corpus IN (${placeholders})
          ORDER BY score ASC LIMIT ?
        `).all(match, ...allowed, limit * 3);
        rows.forEach((row) => found.set(row.id, row));
      } catch {
        // Some SQLite builds ship without trigram tokenization. The LIKE
        // fallback below still keeps short and CJK queries usable.
      }
    }
    const tokens = queryTokens(source);
    const fallbackCorpora = allowed.filter((corpus) => CORPUS_META[corpus]?.kind === 'definition');
    if (found.size < limit && tokens.length && fallbackCorpora.length) {
      // Trigram FTS cannot match one- or two-character Chinese terms. Keep the
      // fallback narrow: scan the short extracted term/title column instead of
      // rescanning every full chunk text, which is noticeably slower on the
      // larger style corpora.
      const fallbackPlaceholders = fallbackCorpora.map(() => '?').join(', ');
      const clauses = tokens.map(() => 'lower(c.terms) LIKE ?').join(' OR ');
      const params = tokens.map((token) => `%${token}%`);
      const rows = db.prepare(`
        SELECT c.id, c.corpus, c.text, c.terms, 0 AS score
        FROM meme_corpus_chunks c
        WHERE c.corpus IN (${fallbackPlaceholders}) AND c.terms <> '' AND (${clauses})
        ORDER BY c.corpus ASC, length(c.terms) ASC, c.id ASC LIMIT ?
      `).all(...fallbackCorpora, ...params, limit * 3);
      rows.forEach((row) => {
        if (!found.has(row.id)) found.set(row.id, row);
      });
    }
    return [...found.values()]
      .sort((left, right) => (
        (CORPUS_META[left.corpus]?.priority ?? 99) - (CORPUS_META[right.corpus]?.priority ?? 99)
        || Number(left.score) - Number(right.score)
      ))
      .slice(0, limit)
      .map((row) => ({
        corpus: row.corpus,
        label: CORPUS_META[row.corpus]?.label ?? row.corpus,
        kind: CORPUS_META[row.corpus]?.kind ?? 'style',
        text: normalized(row.text, MAX_CHUNK),
        terms: normalized(row.terms, 80),
        score: Number(row.score) || 0,
      }));
  }

  buildPrompt(query, options = {}) {
    if (!this.isAvailable()) return '';
    const rows = this.search(query, { ...options, limit: Math.max(4, Number(options.limit) || 8) });
    if (!rows.length) return '';
    const definition = rows.find((row) => row.kind === 'definition' && definitionRelevant(row, query));
    const styles = rows.filter((row) => row.kind === 'style').slice(0, 2);
    const parts = [
      '【中文互联网语料；只作语境和语感参考，不是事实】',
      definition ? `释义参考（${definition.label}）：${definition.text.slice(0, MAX_DEFINITION)}` : '',
      ...styles.map((row, index) => `接法示例${index + 1}（${row.label}）：${row.text.slice(0, MAX_STYLE)}`),
      '用法：先接住当前话题，再按示例的句式和语气自然改写；不要照抄、不要科普、不要罗列出处。与当前场景不贴合就舍弃。',
    ].filter(Boolean);
    return parts.join('\n').slice(0, MAX_PROMPT);
  }

  getStats() {
    const db = this.ensureOpen();
    const rows = db.prepare('SELECT corpus, COUNT(*) AS count FROM meme_corpus_chunks GROUP BY corpus').all();
    return Object.fromEntries(rows.map((row) => [row.corpus, Number(row.count)]));
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

export const MEME_CORPUS_META = CORPUS_META;
export const DEFAULT_MEME_CORPORA = DEFAULT_CORPORA;
