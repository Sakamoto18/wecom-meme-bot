import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TERM = 120;
const MAX_TEXT = 500;
const WIKI_DOMAINS = ['baike.baidu.com', 'zh.wikipedia.org', 'en.wikipedia.org', 'zh.moegirl.org.cn'];
const ASSOCIATION_CONFIDENCE = ['low', 'medium', 'high'];

function text(value, limit = MAX_TEXT) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function list(value, limit = 8) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => text(item, 180)).filter(Boolean))].slice(0, limit);
}

function domains(rows) {
  return list((Array.isArray(rows) ? rows : []).map((row) => {
    try { return new URL(row?.url).hostname.replace(/^www\./i, ''); } catch { return ''; }
  }), 8);
}

export const MEME_WIKI_DOMAINS = Object.freeze([...WIKI_DOMAINS]);

export function buildMemeKnowledgeEntry(term, searchResult, options = {}) {
  const normalizedTerm = text(term, MAX_TERM);
  const rows = Array.isArray(searchResult?.results) ? searchResult.results.slice(0, 4) : [];
  const context = text(searchResult?.context, 1_800);
  if (!normalizedTerm || (!rows.length && !context)) return null;
  const evidence = rows.map((row) => [row?.title, row?.description].filter(Boolean).join('：')).filter(Boolean);
  if (!evidence.length && context) evidence.push(context);
  const meaning = text(options.meaning || evidence.join('；'), MAX_TEXT);
  if (meaning.length < 4) return null;
  const confidence = options.confidence || (rows.length >= 2 ? 'high' : 'medium');
  return {
    term: normalizedTerm,
    aliases: list(options.aliases || [], 8),
    meaning,
    usage: list(options.usage || evidence, 6),
    sourceDomains: domains(rows),
    sourceUrls: list(rows.map((row) => row?.url), 8),
    confidence: ['low', 'medium', 'high'].includes(confidence) ? confidence : 'medium',
    lookupSource: text(options.lookupSource || 'wiki', 40),
  };
}

function normalizedConfidence(value, fallback = 'medium') {
  const confidence = String(value ?? '').trim().toLowerCase();
  return ASSOCIATION_CONFIDENCE.includes(confidence) ? confidence : fallback;
}

export function buildAbstractAssociationEntry(input = {}) {
  const trigger = text(input.trigger || input.impression || input.abstractImpression, 240);
  const target = text(input.target || input.association || input.memeTarget, MAX_TERM);
  const mechanism = text(input.mechanism || input.comicMechanism, 240);
  if (!trigger || !target || !mechanism) return null;
  return {
    trigger,
    target,
    mechanism,
    register: text(input.register || input.culturalRegister || '', 120),
    usage: list(input.usage || input.examples || [], 6),
    aliases: list(input.aliases || [], 8),
    confidence: normalizedConfidence(input.associationConfidence || input.confidence),
    factConfidence: normalizedConfidence(input.factConfidence, 'low'),
    sourceUrls: list(input.sourceUrls || [], 8),
    sourceDomains: list(input.sourceDomains || [], 8),
  };
}

export function abstractAssociationPrompt(entries = [], source = 'memory') {
  const rows = (Array.isArray(entries) ? entries : [])
    .filter(Boolean)
    .slice(0, 5)
    .map((entry) => [
      `触发印象：${text(entry.trigger, 240)}`,
      `联想对象：${text(entry.target, MAX_TERM)}`,
      `机制：${text(entry.mechanism, 240)}`,
      entry.register ? `文化语气：${text(entry.register, 120)}` : '',
      entry.usage?.length ? `常见接法：${list(entry.usage, 3).join('；')}` : '',
    ].filter(Boolean).join('；'));
  if (!rows.length) return '';
  return [
    '【抽象联想记忆；主观文化线索，不是现实事实】',
    ...rows,
    `来源：${source === 'memory' ? '本地群聊联想记忆' : '本轮抽象候选'}`,
    '只把它当作“有那个味”的参考，不要把联想对象写成图片真实身份、作者或出处。没有贴合当前印象就放弃，不要硬塞。',
  ].join('\n');
}

export function memeKnowledgePrompt(entry, source = 'cache') {
  if (!entry) return '';
  return [
    '【网络梗知识条目】',
    `词条：${text(entry.term, MAX_TERM)}`,
    `含义：${text(entry.meaning)}`,
    `用法线索：${list(entry.usage, 4).join('；')}`,
    `证据状态：${source === 'cache' ? '本地高置信梗库' : '本轮定向 wiki 检索'}`,
    `可信度：${entry.confidence}`,
    '只把条目作为当前回答的证据，不要编造出处，不要把不确定的搜索摘要写成现实事实。',
  ].join('\n');
}

export function reviewMemeKnowledgeReply(answer, entry) {
  const value = text(answer, 2_000);
  const issues = [];
  if (!value) issues.push('meme-empty-reply');
  if (/(?:根据搜索结果|资料显示|本轮检索|已核实|搜索到)/u.test(value)) {
    issues.push('meme-search-narration');
  }
  if (/(?:最早出自|原作者是|起源于|就是某人)/u.test(value)
    && !(entry?.sourceUrls?.length > 0)) {
    issues.push('meme-unsupported-provenance');
  }
  return { valid: issues.length === 0, issues };
}

export class MemeKnowledgeStore {
  constructor(options = {}) {
    this.databaseFilePath = text(options.databaseFilePath, 500);
    this.ttlMs = Number(options.ttlMs ?? DEFAULT_TTL_MS);
    this.now = options.now ?? Date.now;
    this.database = null;
  }

  ensureOpen() {
    if (this.database) return this.database;
    if (!this.databaseFilePath) throw new Error('网络梗知识库路径不能为空');
    mkdirSync(path.dirname(this.databaseFilePath), { recursive: true });
    this.database = new DatabaseSync(this.databaseFilePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meme_knowledge (
        term_key TEXT PRIMARY KEY,
        term TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        meaning TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        source_domains_json TEXT NOT NULL,
        source_urls_json TEXT NOT NULL,
        confidence TEXT NOT NULL,
        lookup_source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS meme_knowledge_expiry ON meme_knowledge(expires_at);
      CREATE TABLE IF NOT EXISTS meme_association (
        association_key TEXT PRIMARY KEY,
        trigger_text TEXT NOT NULL,
        target TEXT NOT NULL,
        mechanism TEXT NOT NULL,
        register_text TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        confidence TEXT NOT NULL,
        fact_confidence TEXT NOT NULL,
        source_domains_json TEXT NOT NULL,
        source_urls_json TEXT NOT NULL,
        positive_count INTEGER NOT NULL DEFAULT 0,
        negative_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS meme_association_target ON meme_association(target);
    `);
    return this.database;
  }

  cleanup() {
    this.ensureOpen().prepare('DELETE FROM meme_knowledge WHERE expires_at <= ?').run(this.now());
  }

  lookup(term) {
    const key = text(term, MAX_TERM).toLowerCase();
    if (!key) return null;
    const db = this.ensureOpen();
    this.cleanup();
    const row = db.prepare(`
      SELECT * FROM meme_knowledge
      WHERE (term_key = ? OR aliases_json LIKE ?) AND expires_at > ?
      ORDER BY confidence DESC, last_used_at DESC LIMIT 1
    `).get(key, `%${key}%`, this.now());
    if (!row) return null;
    db.prepare('UPDATE meme_knowledge SET last_used_at = ? WHERE term_key = ?').run(this.now(), row.term_key);
    return this.#row(row);
  }

  put(entry, options = {}) {
    if (!entry || entry.confidence !== 'high') return false;
    const term = text(entry.term, MAX_TERM);
    const meaning = text(entry.meaning);
    if (!term || meaning.length < 4 || !entry.sourceDomains?.length) return false;
    const now = this.now();
    const db = this.ensureOpen();
    db.prepare(`
      INSERT INTO meme_knowledge(
        term_key, term, aliases_json, meaning, usage_json, source_domains_json,
        source_urls_json, confidence, lookup_source, created_at, updated_at,
        expires_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(term_key) DO UPDATE SET
        term=excluded.term, aliases_json=excluded.aliases_json, meaning=excluded.meaning,
        usage_json=excluded.usage_json, source_domains_json=excluded.source_domains_json,
        source_urls_json=excluded.source_urls_json, confidence=excluded.confidence,
        lookup_source=excluded.lookup_source, updated_at=excluded.updated_at,
        expires_at=excluded.expires_at, last_used_at=excluded.last_used_at
    `).run(
      term.toLowerCase(), term, JSON.stringify(list(entry.aliases)), meaning,
      JSON.stringify(list(entry.usage, 6)), JSON.stringify(list(entry.sourceDomains, 8)),
      JSON.stringify(list(entry.sourceUrls, 8)), 'high', text(entry.lookupSource || 'wiki', 40),
      now, now, now + (Number(options.ttlMs) || this.ttlMs), now,
    );
    return true;
  }

  lookupAssociations(impression, options = {}) {
    const query = text(impression, 500).toLowerCase();
    if (!query) return [];
    const limit = Math.max(1, Math.min(8, Number(options.limit) || 5));
    const db = this.ensureOpen();
    const tokens = [...new Set(query.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2))].slice(0, 8);
    if (!tokens.length) return [];
    const clauses = tokens.map(() => '(lower(trigger_text) LIKE ? OR lower(target) LIKE ? OR lower(mechanism) LIKE ? OR lower(register_text) LIKE ?)').join(' OR ');
    const params = tokens.flatMap((token) => [`%${token}%`, `%${token}%`, `%${token}%`, `%${token}%`]);
    const rows = db.prepare(`
      SELECT * FROM meme_association
      WHERE ${clauses}
      ORDER BY (positive_count - negative_count) DESC, confidence DESC, last_used_at DESC
      LIMIT ?
    `).all(...params, limit);
    const now = this.now();
    rows.forEach((row) => db.prepare('UPDATE meme_association SET last_used_at = ? WHERE association_key = ?').run(now, row.association_key));
    return rows.map((row) => this.#associationRow(row));
  }

  putAssociation(entry, options = {}) {
    const normalized = buildAbstractAssociationEntry(entry);
    if (!normalized || normalized.confidence !== 'high') return false;
    const now = this.now();
    // SQLite text bindings truncate at an embedded NUL on some Node builds;
    // use a printable separator so feedback can address the stored row.
    const key = `${normalized.trigger} :: ${normalized.target} :: ${normalized.mechanism}`.toLowerCase();
    const db = this.ensureOpen();
    db.prepare(`
      INSERT INTO meme_association(
        association_key, trigger_text, target, mechanism, register_text, usage_json,
        aliases_json, confidence, fact_confidence, source_domains_json, source_urls_json,
        positive_count, negative_count, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
      ON CONFLICT(association_key) DO UPDATE SET
        trigger_text=excluded.trigger_text, target=excluded.target, mechanism=excluded.mechanism,
        register_text=excluded.register_text, usage_json=excluded.usage_json,
        aliases_json=excluded.aliases_json, confidence=excluded.confidence,
        fact_confidence=excluded.fact_confidence, source_domains_json=excluded.source_domains_json,
        source_urls_json=excluded.source_urls_json, updated_at=excluded.updated_at,
        last_used_at=excluded.last_used_at
    `).run(
      key, normalized.trigger, normalized.target, normalized.mechanism, normalized.register,
      JSON.stringify(normalized.usage), JSON.stringify(normalized.aliases), normalized.confidence,
      normalized.factConfidence, JSON.stringify(normalized.sourceDomains), JSON.stringify(normalized.sourceUrls),
      now, now, now,
    );
    return true;
  }

  recordAssociationFeedback(input = {}) {
    const trigger = text(input.trigger || input.impression, 240).toLowerCase();
    const target = text(input.target || input.association, MAX_TERM).toLowerCase();
    const mechanism = text(input.mechanism, 240).toLowerCase();
    const signal = String(input.signal ?? '').trim().toLowerCase();
    if (!trigger || !target || !['positive', 'negative'].includes(signal)) return false;
    const db = this.ensureOpen();
    const row = db.prepare(`SELECT association_key FROM meme_association WHERE lower(trigger_text) = ? AND lower(target) = ?${mechanism ? ' AND lower(mechanism) = ?' : ''} LIMIT 1`)
      .get(...(mechanism ? [trigger, target, mechanism] : [trigger, target]));
    if (!row) return false;
    const column = signal === 'positive' ? 'positive_count' : 'negative_count';
    db.prepare(`UPDATE meme_association SET ${column} = ${column} + 1, updated_at = ? WHERE association_key = ?`).run(this.now(), row.association_key);
    return true;
  }

  #row(row) {
    const read = (value) => { try { return JSON.parse(value); } catch { return []; } };
    return {
      term: row.term,
      aliases: read(row.aliases_json),
      meaning: row.meaning,
      usage: read(row.usage_json),
      sourceDomains: read(row.source_domains_json),
      sourceUrls: read(row.source_urls_json),
      confidence: row.confidence,
      lookupSource: row.lookup_source,
    };
  }

  #associationRow(row) {
    const read = (value) => { try { return JSON.parse(value); } catch { return []; } };
    return {
      trigger: row.trigger_text,
      target: row.target,
      mechanism: row.mechanism,
      register: row.register_text,
      usage: read(row.usage_json),
      aliases: read(row.aliases_json),
      confidence: row.confidence,
      associationConfidence: row.confidence,
      factConfidence: row.fact_confidence,
      sourceDomains: read(row.source_domains_json),
      sourceUrls: read(row.source_urls_json),
      positiveCount: Number(row.positive_count || 0),
      negativeCount: Number(row.negative_count || 0),
    };
  }

  getStats() {
    this.cleanup();
    const db = this.ensureOpen();
    return {
      entries: Number(db.prepare('SELECT COUNT(*) AS count FROM meme_knowledge').get().count),
      associations: Number(db.prepare('SELECT COUNT(*) AS count FROM meme_association').get().count),
    };
  }

  close() { this.database?.close(); this.database = null; }
}
