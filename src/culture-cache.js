import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2_000;
const MAX_TOPIC_LENGTH = 120;
const MAX_TERMS = 16;
const MAX_DESCRIPTORS = 8;
const MAX_DESCRIPTOR_LENGTH = 180;
const MAX_SOURCE_DOMAINS = 8;

function normalized(value, limit = 500) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
}

function uniqueStrings(values, limit, itemLimit) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalized(value, itemLimit))
    .filter(Boolean))].slice(0, limit);
}

function safeJson(value, fallback = []) {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function termsFromText(value) {
  return [...new Set(normalized(value, 1_000).toLowerCase()
    .match(/[\p{Script=Han}]{2,}|[a-z][a-z0-9_-]{1,}/giu) ?? [])]
    .slice(0, MAX_TERMS);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function descriptorCandidates(text) {
  const source = normalized(text, 1_600);
  if (!source) return [];
  const candidates = [];
  const patterns = [
    /(?:语义|双关|谐音|反差|转职|场景|语境|出处|含义|来源)[：:：]?\s*([^。！？!?；;\n]{4,80})/gu,
    /(?:女鬼|电梯|骑士|骑马|族谱|龙图|梗|抽象|角色)[^。！？!?；;\n]{0,60}/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      candidates.push(match[1] || match[0]);
    }
  }
  if (candidates.length === 0) {
    candidates.push(...source.split(/[。！？!?；;\n]+/u).slice(0, 2));
  }
  return uniqueStrings(candidates, MAX_DESCRIPTORS, MAX_DESCRIPTOR_LENGTH);
}

export function buildCultureCard(query, searchResult, options = {}) {
  const normalizedQuery = normalized(query, MAX_TOPIC_LENGTH);
  const resultRows = (Array.isArray(searchResult?.results) ? searchResult.results : []).slice(0, 4);
  // Test doubles and alternate providers sometimes expose only the compact
  // context string.  Use a bounded sentence sample as a one-turn fallback,
  // while still storing only extracted descriptors in SQLite.
  const rows = resultRows.length > 0
    ? resultRows
    : (normalized(searchResult?.context, 1_600)
      ? [{ title: normalizedQuery, description: normalized(searchResult.context, 1_600), url: '' }]
      : []);
  if (!normalizedQuery || rows.length === 0) return null;
  const evidence = rows.map((row) => [row?.title, row?.description].filter(Boolean).join('：'))
    .filter(Boolean).join('；');
  const terms = uniqueStrings([
    ...termsFromText(normalizedQuery),
    ...rows.flatMap((row) => termsFromText(`${row?.title ?? ''} ${row?.description ?? ''}`)),
  ], MAX_TERMS, 60);
  const descriptors = descriptorCandidates(evidence);
  if (descriptors.length === 0) return null;
  const sourceDomains = uniqueStrings(rows.map((row) => hostOf(row?.url)), MAX_SOURCE_DOMAINS, 120);
  return {
    topicKey: normalizedQuery.toLowerCase(),
    normalizedTopic: normalizedQuery,
    confidence: options.confidence || 'high',
    terms,
    descriptors,
    forbiddenTargets: [
      '不把文化材料当成现实事实',
      '不攻击提问者、引用作者或无关第三方',
    ],
    sourceDomains,
  };
}

export function cultureCardPrompt(card, source = 'cache') {
  if (!card) return '';
  return [
    '【本轮文化检索短卡】',
    `主题：${normalized(card.normalizedTopic, MAX_TOPIC_LENGTH)}`,
    `文化线索：${uniqueStrings(card.descriptors, MAX_DESCRIPTORS, MAX_DESCRIPTOR_LENGTH).join('；')}`,
    `检索来源状态：${source === 'cache' ? '本地缓存短卡' : '本轮公开检索后提炼'}`,
    '只把这些线索融入当前回复，不复述来源、网页正文或检索过程；不贴合就不用，不强塞固定梗。',
    `边界：${uniqueStrings(card.forbiddenTargets, 4, 120).join('；')}`,
  ].join('\n');
}

export class CultureCache {
  constructor(options = {}) {
    this.databaseFilePath = String(options.databaseFilePath ?? '').trim();
    this.ttlMs = Number(options.ttlMs ?? DEFAULT_TTL_MS);
    this.maxEntries = Number(options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.database = null;
  }

  ensureOpen() {
    if (this.database) return this.database;
    if (!this.databaseFilePath) throw new Error('文化缓存数据库路径不能为空');
    mkdirSync(path.dirname(this.databaseFilePath), { recursive: true });
    this.database = new DatabaseSync(this.databaseFilePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS culture_topics (
        topic_key TEXT PRIMARY KEY,
        normalized_topic TEXT NOT NULL,
        confidence TEXT NOT NULL,
        terms_json TEXT NOT NULL,
        descriptors_json TEXT NOT NULL,
        forbidden_targets_json TEXT NOT NULL,
        source_domains_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS culture_topics_fts USING fts5(
        topic_key UNINDEXED,
        terms,
        descriptors
      );
      CREATE INDEX IF NOT EXISTS culture_topics_expiry ON culture_topics(expires_at);
      CREATE INDEX IF NOT EXISTS culture_topics_recent ON culture_topics(last_used_at DESC);
    `);
    return this.database;
  }

  cleanup() {
    const database = this.ensureOpen();
    const now = this.now();
    database.prepare('DELETE FROM culture_topics WHERE expires_at <= ?').run(now);
    database.prepare('DELETE FROM culture_topics_fts WHERE topic_key NOT IN (SELECT topic_key FROM culture_topics)').run();
    const count = Number(database.prepare('SELECT COUNT(*) AS count FROM culture_topics').get().count);
    if (count > this.maxEntries) {
      database.prepare(`
        DELETE FROM culture_topics
        WHERE topic_key IN (
          SELECT topic_key FROM culture_topics ORDER BY last_used_at ASC LIMIT ?
        )
      `).run(count - this.maxEntries);
      database.prepare('DELETE FROM culture_topics_fts WHERE topic_key NOT IN (SELECT topic_key FROM culture_topics)').run();
    }
  }

  lookup(query) {
    const database = this.ensureOpen();
    this.cleanup();
    const key = normalized(query, MAX_TOPIC_LENGTH).toLowerCase();
    if (!key) return null;
    let row = database.prepare('SELECT * FROM culture_topics WHERE topic_key = ? AND expires_at > ?').get(key, this.now());
    if (!row) {
      const terms = termsFromText(key).filter((term) => term.length >= 2);
      if (terms.length > 0) {
        const match = terms.map((term) => `"${term.replaceAll('"', ' ')}"`).join(' OR ');
        const hit = database.prepare(`SELECT topic_key FROM culture_topics_fts WHERE culture_topics_fts MATCH ? LIMIT 1`).get(match);
        if (hit?.topic_key) row = database.prepare('SELECT * FROM culture_topics WHERE topic_key = ? AND expires_at > ?').get(hit.topic_key, this.now());
        if (!row) {
          // The default FTS tokenizer treats a long Han phrase as one token,
          // so a shorter follow-up such as “女鬼电梯” may not MATCH
          // “女鬼电梯语境”. Keep FTS as the primary path and use a bounded
          // substring fallback for this small local table.
          const likeTerms = terms.map((term) => `%${term}%`);
          const likeHit = database.prepare(
            'SELECT topic_key FROM culture_topics_fts WHERE terms LIKE ? OR descriptors LIKE ? LIMIT 1',
          ).get(likeTerms[0], likeTerms[0]);
          if (likeHit?.topic_key) {
            row = database.prepare('SELECT * FROM culture_topics WHERE topic_key = ? AND expires_at > ?')
              .get(likeHit.topic_key, this.now());
          }
        }
      }
    }
    if (!row) return null;
    database.prepare('UPDATE culture_topics SET last_used_at = ? WHERE topic_key = ?').run(this.now(), row.topic_key);
    return {
      topicKey: row.topic_key,
      normalizedTopic: row.normalized_topic,
      confidence: row.confidence,
      terms: safeJson(row.terms_json),
      descriptors: safeJson(row.descriptors_json),
      forbiddenTargets: safeJson(row.forbidden_targets_json),
      sourceDomains: safeJson(row.source_domains_json),
    };
  }

  put(card) {
    if (!card?.topicKey || !Array.isArray(card.descriptors) || card.descriptors.length === 0) return false;
    const database = this.ensureOpen();
    const now = this.now();
    const values = {
      topicKey: normalized(card.topicKey, MAX_TOPIC_LENGTH).toLowerCase(),
      normalizedTopic: normalized(card.normalizedTopic || card.topicKey, MAX_TOPIC_LENGTH),
      confidence: ['low', 'medium', 'high'].includes(card.confidence) ? card.confidence : 'medium',
      terms: uniqueStrings(card.terms, MAX_TERMS, 60),
      descriptors: uniqueStrings(card.descriptors, MAX_DESCRIPTORS, MAX_DESCRIPTOR_LENGTH),
      forbiddenTargets: uniqueStrings(card.forbiddenTargets, 4, 120),
      sourceDomains: uniqueStrings(card.sourceDomains, MAX_SOURCE_DOMAINS, 120),
    };
    if (!values.topicKey || values.descriptors.length === 0) return false;
    database.prepare(`
      INSERT INTO culture_topics(
        topic_key, normalized_topic, confidence, terms_json, descriptors_json,
        forbidden_targets_json, source_domains_json, created_at, updated_at,
        expires_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(topic_key) DO UPDATE SET
        normalized_topic=excluded.normalized_topic,
        confidence=excluded.confidence,
        terms_json=excluded.terms_json,
        descriptors_json=excluded.descriptors_json,
        forbidden_targets_json=excluded.forbidden_targets_json,
        source_domains_json=excluded.source_domains_json,
        updated_at=excluded.updated_at,
        expires_at=excluded.expires_at,
        last_used_at=excluded.last_used_at
    `).run(
      values.topicKey, values.normalizedTopic, values.confidence,
      JSON.stringify(values.terms), JSON.stringify(values.descriptors),
      JSON.stringify(values.forbiddenTargets), JSON.stringify(values.sourceDomains),
      now, now, now + this.ttlMs, now,
    );
    database.prepare('DELETE FROM culture_topics_fts WHERE topic_key = ?').run(values.topicKey);
    database.prepare('INSERT INTO culture_topics_fts(topic_key, terms, descriptors) VALUES (?, ?, ?)').run(
      values.topicKey, values.terms.join(' '), values.descriptors.join(' '),
    );
    this.cleanup();
    return true;
  }

  getStats() {
    const database = this.ensureOpen();
    this.cleanup();
    return {
      topics: Number(database.prepare('SELECT COUNT(*) AS count FROM culture_topics').get().count),
    };
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}
