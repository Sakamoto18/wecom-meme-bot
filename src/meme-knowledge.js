import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TERM = 120;
const MAX_TEXT = 500;
// 中文互联网梗优先看 B 站公开梗视频/专栏与相关词条，再用百科和 Wiki
// 补定义、别名与背景。搜索结果仍需经过 exact/related 质量门，不能因为
// 命中 B 站域名就直接把标题当成梗义。
const WIKI_DOMAINS = ['bilibili.com', 'b23.tv', 'baike.baidu.com', 'zh.moegirl.org.cn', 'zh.wikipedia.org', 'en.wikipedia.org'];
const ASSOCIATION_CONFIDENCE = ['low', 'medium', 'high'];

function text(value, limit = MAX_TEXT) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function list(value, limit = 8) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => text(item, 180)).filter(Boolean))].slice(0, limit);
}

function read(value) {
  try { return JSON.parse(value); } catch { return []; }
}

function richList(value, limit) {
  return (Array.isArray(value) ? value : []).filter((item) => item && typeof item === 'object').slice(0, limit);
}

// Lowercase, no spaces or punctuation: what phrase matching compares.
function phraseText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 200);
}

// Reuse a learned lyric's structure, never a global list of meme names.
function matchLearnedLyric(message, lyrics) {
  const confirmed = richList(lyrics, 8).filter((item) => item.confidence !== 'low');
  for (const item of confirmed) {
    const line = phraseText(item.line);
    if (line.length >= 4 && message.includes(line)) {
      return { matchType: 'lyric', matchedPhrase: line, length: line.length };
    }
  }
  for (const item of confirmed) {
    const line = phraseText(item.line);
    if (line.length < 4) continue;
    // A distinctive repeated opening can survive replacement of the rest of
    // the line. Single-character laughter/repetition is not a lyric signal.
    const opening = line.match(/^([\p{Script=Han}]{2,4})\1/u);
    if (opening && new Set(opening[1]).size > 1 && message.length <= 80
      && message.includes(opening[0])) {
      return { matchType: 'lyric-template', matchedPhrase: line, length: opening[0].length };
    }
  }
  return null;
}

function longestCommonRun(left, right) {
  let best = 0;
  const previous = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = left[i - 1] === right[j - 1] ? diagonal + 1 : 0;
      if (previous[j] > best) best = previous[j];
      diagonal = above;
    }
  }
  return best;
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
    realityAnchor: text(input.realityAnchor || input.reality_anchor || '', 240),
    memeClaim: text(input.memeClaim || input.meme_claim || '', 240),
    informationKind: text(input.informationKind || input.information_kind || '', 40).toLowerCase(),
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
      entry.realityAnchor ? `现实锚点：${text(entry.realityAnchor, 240)}` : '',
      entry.memeClaim ? `梗的改写：${text(entry.memeClaim, 240)}` : '',
      entry.informationKind ? `信息类型：${text(entry.informationKind, 40)}` : '',
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

const DAY_MS = 24 * 60 * 60 * 1000;

export function memeKnowledgePrompt(entry, source = 'cache', options = {}) {
  if (!entry) return '';
  const now = options.now ?? Date.now();
  const lyrics = richList(entry.lyrics, 8).filter((line) => text(line.line, 60));
  const events = richList(entry.currentEvents, 6)
    .filter((event) => !(Number(event.expiresAt) > 0 && Number(event.expiresAt) <= now));
  const reception = entry.reception && typeof entry.reception === 'object' ? entry.reception : {};
  return [
    '【网络梗知识条目】',
    `词条：${text(entry.term, MAX_TERM)}`,
    `含义：${text(entry.meaning)}`,
    `用法线索：${list(entry.usage, 4).join('；')}`,
    entry.matchedPhrase ? `当前消息命中：${text(entry.matchedPhrase, 60)}` : '',
    lyrics.length
      ? `已确认的歌词/口头禅（按顺序）：${lyrics.map((line) => `${text(line.line, 30)}${line.position ? `（${text(line.position, 10)}）` : ''}`).join(' / ')}`
      : '',
    reception.summary ? `评论区共识（网友怎么看，不是事实）：${text(reception.summary, 200)}` : '',
    list(reception.phrases, 6).length ? `评论区常刷：${list(reception.phrases, 6).join('、')}` : '',
    ...events.map((event) => {
      const age = Number(event.learnedAt) > 0 && now - Number(event.learnedAt) > 7 * DAY_MS ? '，已超过 7 天，不要说成刚刚或昨天' : '';
      const status = event.verified ? '已核实' : '评论区在说，未核实';
      return `时事（${text(event.time, 20) || '时间未知'}，${status}${age}）：${text(event.subject, 30)} ${text(event.claim || event.event, 160)}`;
    }),
    list(entry.replyHooks, 4).length ? `可接话的说法：${list(entry.replyHooks, 4).join('；')}` : '',
    `证据状态：${entry.confidence === 'medium' ? '全局候选梗记忆（事实待核实）' : source === 'cache' ? '本地高置信梗库' : '本轮定向 B 站梗语境/百科检索'}`,
    `可信度：${entry.confidence}`,
    entry.confidence === 'medium' ? '候选只可借用梗义、反差和适用场景自然接话；不能据此断言出处、人物身份、原句或现实事件。被问到来源时明确尚未核实，不播报内部学习过程。' : '',
    options.intent ? MEME_INTENT_RULES[options.intent] ?? '' : '',
    '只把条目作为当前回答的证据，不要编造出处，不要把不确定的搜索摘要写成现实事实。不要编下一句歌词，不要把即兴改词冒充原作，不要编比赛结果，不要把评论区说法当事实，不要提学习过程、视频或链接。',
  ].filter(Boolean).join('\n');
}

// Reply focus per intent (plan §7.2).
export const MEME_INTENT_RULES = Object.freeze({
  'lyric-template': '本轮是接改词梗：用户借用了已学副歌的重复结构。先接住用户替换的新场景，可以沿相同节奏接一小句即兴改词；这是本轮二创，不是原作下一句，不得声称出自原视频。不要把旧版本的队伍或人物硬套到当前场景，不要用泛泛互怼盖过接梗，也不用解释梗义。',
  lyric: '本轮是接歌词：只接上面已确认的原句，接在当前消息那句之后；不知道下一句就直说“这版我就记到这句”，不要现编。',
  evaluate: '本轮是评价：结合视频内容和评论区共识说看法；时事只按上面的状态说，没核实的说成“评论区在说”。',
  explain: '本轮是解释：说清梗义和用法，有确认的出处再带一句。',
  default: '本轮是自然接梗：从可接话的说法、用法线索中选一个贴合当前场景的落点，顺着用户接一两句，不要复述梗义或宣布识别成功。例句只借结构，不照搬旧人物、队伍和事件；不贴题就不硬塞。',
});

export function memeReplyIntent(message, entry) {
  const value = String(message ?? '');
  // An explicit request wins; a quoted lyric line alone means "continue it".
  if (/(?:下一句|接歌词|接着唱|唱一下|唱下去)/u.test(value)) return 'lyric';
  if (/(?:怎么样|如何|评价|好听吗|锐评|这场|比赛|打得)/u.test(value)) return 'evaluate';
  if (/(?:什么意思|啥意思|什么梗|啥梗|为什么|出处|来源|怎么来的)/u.test(value)) return 'explain';
  if (entry?.matchType === 'lyric-template') return 'lyric-template';
  return ['lyric', 'lyric-fragment'].includes(entry?.matchType) ? 'lyric' : 'default';
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
        reality_anchor TEXT NOT NULL DEFAULT '',
        meme_claim TEXT NOT NULL DEFAULT '',
        information_kind TEXT NOT NULL DEFAULT '',
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
      CREATE TABLE IF NOT EXISTS taught_association (
        scope TEXT NOT NULL,
        trigger_key TEXT NOT NULL,
        target_key TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        evidence_text TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(scope, trigger_key, target_key)
      );
    `);
    const associationColumns = new Set(
      this.database.prepare('PRAGMA table_info(meme_association)').all()
        .map((row) => String(row.name)),
    );
    for (const [name, definition] of [
      ['reality_anchor', "TEXT NOT NULL DEFAULT ''"],
      ['meme_claim', "TEXT NOT NULL DEFAULT ''"],
      ['information_kind', "TEXT NOT NULL DEFAULT ''"],
    ]) {
      if (!associationColumns.has(name)) {
        this.database.exec(`ALTER TABLE meme_association ADD COLUMN ${name} ${definition}`);
      }
    }
    // Video learning stores lyrics, comment consensus, current events and
    // reply hooks alongside the meaning (docs/VIDEO_COMMENT_LEARNING_PLAN.md §6.3).
    const knowledgeColumns = new Set(
      this.database.prepare('PRAGMA table_info(meme_knowledge)').all().map((row) => String(row.name)),
    );
    for (const name of ['lyrics_json', 'context_json', 'reception_json', 'reply_hooks_json']) {
      if (!knowledgeColumns.has(name)) {
        this.database.exec(`ALTER TABLE meme_knowledge ADD COLUMN ${name} TEXT NOT NULL DEFAULT '[]'`);
      }
    }
    this.database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS meme_knowledge_fts USING fts5(
        term_key UNINDEXED,
        text,
        tokenize='trigram'
      );
    `);
    return this.database;
  }

  // Phrases a later message may quote: name, aliases, lyric lines, comment
  // phrases and reply hooks. Rewritten on every put, without triggers.
  #indexPhrases(termKey, entry) {
    const db = this.ensureOpen();
    db.prepare('DELETE FROM meme_knowledge_fts WHERE term_key = ?').run(termKey);
    const phrases = [...new Set([
      entry.term,
      ...list(entry.aliases, 8),
      ...richList(entry.lyrics, 8).map((line) => line.line),
      ...list(entry.reception?.phrases, 8),
      ...list(entry.replyHooks, 6),
    ].map((phrase) => phraseText(phrase)).filter((phrase) => phrase.length >= 2))];
    const insert = db.prepare('INSERT INTO meme_knowledge_fts(term_key, text) VALUES (?, ?)');
    for (const phrase of phrases) insert.run(termKey, phrase);
  }

  /**
   * Finds learned knowledge quoted by a message (plan §7.1). A hit needs an
   * exact name/alias, a stored lyric line, two 3+ character fragments, or one
   * 5+ character fragment; single characters never match.
   */
  lookupPhrase(value) {
    const message = phraseText(value);
    if (message.length < 2) return null;
    const db = this.ensureOpen();
    this.cleanup();
    const rows = db.prepare(`
      SELECT f.term_key AS termKey, f.text AS phrase, k.lyrics_json AS lyrics FROM meme_knowledge_fts f
      JOIN meme_knowledge k ON k.term_key = f.term_key
      WHERE k.expires_at > ?
    `).all(this.now());
    const scores = new Map();
    for (const row of rows) {
      const phrase = String(row.phrase ?? '');
      if (phrase.length < 2) continue;
      let matchedLength = 0;
      let matchType = '';
      if (message.includes(phrase)) {
        matchedLength = phrase.length;
        matchType = 'phrase';
      } else {
        matchedLength = longestCommonRun(message, phrase);
        if (matchedLength >= 3) matchType = 'fragment';
      }
      if (!matchType) continue;
      const current = scores.get(row.termKey) ?? { termKey: row.termKey, best: 0, fragments: 0, matchType: '', matchedPhrase: '' };
      if (matchType === 'phrase' && (current.matchType !== 'phrase' || matchedLength > current.best)) {
        Object.assign(current, { matchType: 'phrase', best: matchedLength, matchedPhrase: phrase });
      } else if (matchType === 'fragment') {
        current.fragments += 1;
        if (current.matchType !== 'phrase' && matchedLength > current.best) {
          Object.assign(current, { matchType: 'fragment', best: matchedLength, matchedPhrase: phrase });
        }
      }
      scores.set(row.termKey, current);
    }
    const lyricMatches = new Map();
    const checkedLyrics = new Set();
    for (const row of rows) {
      if (checkedLyrics.has(row.termKey)) continue;
      checkedLyrics.add(row.termKey);
      const match = matchLearnedLyric(message, read(row.lyrics));
      if (!match) continue;
      lyricMatches.set(row.termKey, match);
      const score = scores.get(row.termKey);
      if (!score || score.best < match.length) {
        scores.set(row.termKey, { termKey: row.termKey, best: match.length,
          fragments: 0, matchType: match.matchType, matchedPhrase: match.matchedPhrase });
      }
    }
    const accepted = [...scores.values()].filter((item) => (
      lyricMatches.has(item.termKey)
      || (item.matchType === 'phrase' && item.best >= 2)
      || (item.matchType === 'fragment' && (item.best >= 5 || item.fragments >= 2))
    )).sort((left, right) => (right.matchType === 'phrase') - (left.matchType === 'phrase') || right.best - left.best);
    const hit = accepted[0];
    if (!hit) return null;
    // The same refrain can belong to several remixes. Without a stronger
    // match, don't pick an unrelated version just because it was stored first.
    if (lyricMatches.get(hit.termKey)?.matchType === 'lyric-template'
      && accepted.some((other) => other.termKey !== hit.termKey && other.best === hit.best
        && lyricMatches.get(other.termKey)?.matchType === 'lyric-template')) return null;
    const row = db.prepare('SELECT * FROM meme_knowledge WHERE term_key = ? AND expires_at > ?').get(hit.termKey, this.now());
    if (!row) return null;
    db.prepare('UPDATE meme_knowledge SET last_used_at = ? WHERE term_key = ?').run(this.now(), row.term_key);
    return {
      ...this.#row(row),
      matchType: lyricMatches.get(hit.termKey)?.matchType
        || (richList(read(row.lyrics_json), 8).some((line) => phraseText(line.line) === hit.matchedPhrase)
          ? 'lyric-fragment' : hit.matchType),
      matchedPhrase: lyricMatches.get(hit.termKey)?.matchedPhrase || hit.matchedPhrase,
    };
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
      ORDER BY (confidence = 'high') DESC, last_used_at DESC LIMIT 1
    `).get(key, `%${key}%`, this.now());
    if (!row) return null;
    db.prepare('UPDATE meme_knowledge SET last_used_at = ? WHERE term_key = ?').run(this.now(), row.term_key);
    return this.#row(row);
  }

  put(entry, options = {}) {
    if (!entry || entry.confidence !== 'high') return false;
    return this.#putKnowledge(entry, options);
  }

  // Explicit video-only candidate path: ordinary search still requires high confidence.
  putCandidate(entry, options = {}) {
    if (!entry || entry.confidence !== 'medium' || entry.verified !== false
      || entry.lookupSource !== 'video' || !entry.sourceUrls?.length) return false;
    const current = this.ensureOpen().prepare('SELECT confidence, expires_at FROM meme_knowledge WHERE term_key = ?')
      .get(text(entry.term, MAX_TERM).toLowerCase());
    if (current?.confidence === 'high' && current.expires_at > this.now()) return false;
    return this.#putKnowledge({ ...entry, lookupSource: 'video-candidate',
      lyrics: [], currentEvents: [], reception: {}, replyHooks: [] },
    { ...options, ttlMs: Math.min(Number(options.ttlMs) || 30 * DAY_MS, 30 * DAY_MS) });
  }

  #putKnowledge(entry, options) {
    const term = text(entry.term, MAX_TERM);
    const meaning = text(entry.meaning);
    if (!term || meaning.length < 4 || !entry.sourceDomains?.length) return false;
    const now = this.now();
    const db = this.ensureOpen();
    db.prepare(`
      INSERT INTO meme_knowledge(
        term_key, term, aliases_json, meaning, usage_json, source_domains_json,
        source_urls_json, confidence, lookup_source, created_at, updated_at,
        expires_at, last_used_at, lyrics_json, context_json, reception_json, reply_hooks_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(term_key) DO UPDATE SET
        term=excluded.term, aliases_json=excluded.aliases_json, meaning=excluded.meaning,
        usage_json=excluded.usage_json, source_domains_json=excluded.source_domains_json,
        source_urls_json=excluded.source_urls_json, confidence=excluded.confidence,
        lookup_source=excluded.lookup_source, updated_at=excluded.updated_at,
        expires_at=excluded.expires_at, last_used_at=excluded.last_used_at,
        lyrics_json=excluded.lyrics_json, context_json=excluded.context_json,
        reception_json=excluded.reception_json, reply_hooks_json=excluded.reply_hooks_json
    `).run(
      term.toLowerCase(), term, JSON.stringify(list(entry.aliases)), meaning,
      JSON.stringify(list(entry.usage, 6)), JSON.stringify(list(entry.sourceDomains, 8)),
      JSON.stringify(list(entry.sourceUrls, 8)), entry.confidence, text(entry.lookupSource || 'wiki', 40),
      now, now, now + (Number(options.ttlMs) || this.ttlMs), now,
      JSON.stringify(richList(entry.lyrics, 8)),
      JSON.stringify(richList(entry.currentEvents, 6)),
      JSON.stringify(entry.reception && typeof entry.reception === 'object' ? entry.reception : {}),
      JSON.stringify(list(entry.replyHooks, 6)),
    );
    this.#indexPhrases(term.toLowerCase(), entry);
    return true;
  }

  lookupAssociations(impression, options = {}) {
    const query = text(impression, 500).toLowerCase();
    if (!query) return [];
    const limit = Math.max(1, Math.min(8, Number(options.limit) || 5));
    const db = this.ensureOpen();
    const tokens = [...new Set(query.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2))].slice(0, 8);
    if (!tokens.length) return [];
    const normalizedQuery = phraseText(query);
    const rows = db.prepare('SELECT * FROM meme_association').all()
      .map((row) => {
        const anchors = [row.trigger_text, row.target, ...list(read(row.aliases_json))];
        let score = 0;
        for (const value of anchors) {
          const anchor = phraseText(value);
          if (anchor.length < 2) continue;
          if (normalizedQuery.includes(anchor)) score = Math.max(score, anchor.length + 10);
          for (const token of tokens) {
            if (token.length >= 2 && String(value).toLowerCase().includes(token)) score = Math.max(score, token.length);
          }
          const overlap = longestCommonRun(normalizedQuery, anchor);
          if (overlap >= 4 && overlap / anchor.length >= 0.35) score = Math.max(score, overlap);
        }
        return { row, score };
      }).filter((hit) => hit.score > 0)
      .sort((a, b) => (b.row.positive_count - b.row.negative_count) - (a.row.positive_count - a.row.negative_count)
        || b.score - a.score || b.row.last_used_at - a.row.last_used_at)
      .slice(0, limit).map((hit) => hit.row);
    const now = this.now();
    rows.forEach((row) => db.prepare('UPDATE meme_association SET last_used_at = ? WHERE association_key = ?').run(now, row.association_key));
    return rows.map((row) => this.#associationRow(row));
  }

  listAssociationCandidates(limit = 48, query = '') {
    const db = this.ensureOpen();
    const count = Math.max(3, Math.min(72, Number(limit) || 48));
    const perSource = Math.ceil(count / 3);
    const asCandidate = (entry) => ({ trigger: entry.term, target: entry.term, mechanism: entry.meaning,
      usage: [...entry.usage, ...entry.replyHooks], confidence: entry.confidence,
      factConfidence: entry.confidence === 'medium' ? 'low' : entry.confidence,
      source: entry.confidence === 'medium' ? 'video-candidate' : 'learned-meme' });
    const direct = query ? this.lookupPhrase(query) : null;
    const matched = query ? [
      ...(direct ? [asCandidate(direct)] : []),
      ...this.lookupTaughtAssociations('global', query),
      ...this.lookupAssociations(query, { limit: 8 }),
    ] : [];
    const taught = db.prepare(`SELECT entry_json FROM taught_association
      WHERE scope = 'global' ORDER BY updated_at DESC LIMIT ?`).all(perSource)
      .map((row) => ({ ...read(row.entry_json), source: 'teaching' }));
    const associations = db.prepare(`SELECT * FROM meme_association
      WHERE negative_count <= positive_count AND confidence = 'high'
      ORDER BY (positive_count - negative_count) DESC, updated_at DESC LIMIT ?`).all(perSource)
      .map((row) => ({ ...this.#associationRow(row), source: 'association' }));
    // Existing video entries become usable without waiting for a migration or
    // another viewing pass; meaning/usage already preserve their mechanism.
    const videos = db.prepare(`SELECT * FROM meme_knowledge
      WHERE confidence IN ('high', 'medium') AND expires_at > ? ORDER BY updated_at DESC LIMIT ?`)
      .all(this.now(), perSource).map((row) => {
        const entry = this.#row(row);
        return asCandidate(entry);
      });
    const seen = new Set();
    return [...matched, ...taught, ...associations, ...videos].filter((entry) => {
      const key = `${entry.target}::${entry.mechanism}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, count);
  }

  saveTaughtAssociation(scope, entry, evidence) {
    const normalized = buildAbstractAssociationEntry(entry);
    if (!scope || !normalized || normalized.confidence !== 'high') return false;
    this.ensureOpen().prepare(`INSERT INTO taught_association VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, trigger_key, target_key) DO UPDATE SET
      entry_json=excluded.entry_json, evidence_text=excluded.evidence_text, updated_at=excluded.updated_at`)
      .run(text(scope, 180), phraseText(normalized.trigger), phraseText(normalized.target),
        JSON.stringify(normalized), text(evidence, 600), this.now());
    return true;
  }

  forgetTaughtAssociation(scope, trigger, target) {
    return this.ensureOpen().prepare(`DELETE FROM taught_association
      WHERE scope = ? AND trigger_key = ? AND target_key = ?`)
      .run(text(scope, 180), phraseText(trigger), phraseText(target)).changes > 0;
  }

  lookupTaughtAssociations(scope, message) {
    if (!scope) return [];
    const query = phraseText(message);
    if (query.length < 2) return [];
    return this.ensureOpen().prepare('SELECT entry_json FROM taught_association WHERE scope = ? ORDER BY updated_at DESC')
      .all(text(scope, 180)).map((row) => read(row.entry_json)).map((entry) => {
        // Match stored anchors inside a complete sentence, not the complete
        // incoming Chinese sentence inside the stored phrase.
        const anchors = [entry.trigger, ...list(entry.aliases)];
        const hits = anchors.map(phraseText).filter((anchor) => anchor.length >= 2 && query.includes(anchor));
        return { entry, score: Math.max(0, ...hits.map((hit) => hit.length)) };
      }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score)
      .slice(0, 4).map((hit) => hit.entry);
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
        association_key, trigger_text, target, mechanism, register_text,
        reality_anchor, meme_claim, information_kind, usage_json,
        aliases_json, confidence, fact_confidence, source_domains_json, source_urls_json,
        positive_count, negative_count, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
      ON CONFLICT(association_key) DO UPDATE SET
        trigger_text=excluded.trigger_text, target=excluded.target, mechanism=excluded.mechanism,
        register_text=excluded.register_text, reality_anchor=excluded.reality_anchor,
        meme_claim=excluded.meme_claim, information_kind=excluded.information_kind,
        usage_json=excluded.usage_json,
        aliases_json=excluded.aliases_json, confidence=excluded.confidence,
        fact_confidence=excluded.fact_confidence, source_domains_json=excluded.source_domains_json,
        source_urls_json=excluded.source_urls_json, updated_at=excluded.updated_at,
        last_used_at=excluded.last_used_at
    `).run(
      key, normalized.trigger, normalized.target, normalized.mechanism, normalized.register,
      normalized.realityAnchor, normalized.memeClaim, normalized.informationKind,
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
    const reception = read(row.reception_json ?? '{}');
    return {
      term: row.term,
      aliases: read(row.aliases_json),
      meaning: row.meaning,
      usage: read(row.usage_json),
      sourceDomains: read(row.source_domains_json),
      sourceUrls: read(row.source_urls_json),
      confidence: row.confidence,
      verified: row.confidence === 'high',
      lookupSource: row.lookup_source,
      lyrics: richList(read(row.lyrics_json ?? '[]'), 8),
      currentEvents: richList(read(row.context_json ?? '[]'), 6),
      reception: reception && !Array.isArray(reception) && typeof reception === 'object' ? reception : {},
      replyHooks: list(read(row.reply_hooks_json ?? '[]'), 6),
    };
  }

  #associationRow(row) {
    const read = (value) => { try { return JSON.parse(value); } catch { return []; } };
    return {
      trigger: row.trigger_text,
      target: row.target,
      mechanism: row.mechanism,
      register: row.register_text,
      realityAnchor: row.reality_anchor,
      memeClaim: row.meme_claim,
      informationKind: row.information_kind,
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
