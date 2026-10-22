import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const DEFAULT_TOPIC_IDLE_MS = 25 * MINUTE_MS;
const DEFAULT_TOPIC_KEEP_CLOSED_MS = 48 * HOUR_MS;
const DEFAULT_MAX_ACTIVE_TOPICS = 8;
const DEFAULT_CONTEXT_MESSAGES = 50;
const DEFAULT_CONTEXT_CHARACTERS = 20_000;
const DEFAULT_DIRECT_CONTEXT_MESSAGES = 12;
const DEFAULT_DIRECT_CONTEXT_CHARACTERS = 6_000;
const DEFAULT_STYLE_REFRESH_HOURS = 6;
const DEFAULT_SUMMARY_IDLE_MS = 60 * 1000;
const DEFAULT_SUMMARY_TRIGGER_MESSAGES = 10;
const DEFAULT_MAX_STYLE_EXAMPLES = 3_000;
const DEFAULT_MAX_REFERENCE_EXAMPLES = 300;
// 新群先积累一小批真实发言就开始提供基础语感；后续刷新会持续用全量历史重建。
const MIN_STYLE_SOURCE_MESSAGES = 30;
const MIN_STYLE_CARD_MESSAGES = 24;
const TOPIC_MATCH_THRESHOLD = 0.65;
const TOPIC_ASSIGN_THRESHOLD = 0.45;
const TOPIC_AMBIGUITY_MARGIN = 0.08;
const SAME_SENDER_CONTINUATION_MS = 6 * MINUTE_MS;
const CLOSED_TOPIC_PENALTY = 0.12;

const STOP_TERMS = new Set([
  '这个', '那个', '什么', '怎么', '为什么', '可以', '就是', '不是', '没有',
  '我们', '你们', '他们', '自己', '现在', '已经', '还是', '真的', '一个',
  '一下', '这样', '那样', '然后', '但是', '因为', '所以', '如果', '感觉',
  '知道', '觉得', '有点', '不是', '不会', '不能', '可能', '应该', '直接',
  '以及', '还有', '而且', '其实', '这种', '那种', '群友', '消息', '问题',
  '当前', '本轮', '内容', '图片', '截图', '群里', '刚才', '上面', '下面',
]);
const STOP_CHARS = new Set([...'的了是在我你他她它这那个吗呢吧啊呀就都也还又很挺和有没不么什晚上午中里外前后今明点分想去看好来谁说话时候现开打做用能会要可给对跟和与再最太真']);

const ACK_PATTERN = /^(?:哈+|呵+|嗯+|哦+|噢+|草+|靠+|？+|\?+|6+|牛+|行|好|收到|可以|确实|真的|笑死|绷不住了?|太对了|离谱|抽象|逆天|无敌|没毛病|确实如此)[。！？!?~～\s]*$/u;
const SAFE_EXAMPLE_PATTERN = /(?:https?:\/\/|www\.|【.*?】|记住我的|确认保存|token|api\s*key|密码|身份证|手机号|银行卡|住址|自杀|自残|裸奔|强奸|儿童色情)/iu;
const ATTACK_EXAMPLE_PATTERN = /(?:傻逼|沙比|妈的|你妈|他妈|滚|废物|贱|狗|脑残|弱智|闭嘴|挨骂|挨打|老子|爷|草你|操你|cnm|nmsl)/iu;
const STYLE_NOISE_PATTERN = /(?:[（(]\s*(?:发送|用户|系统|机器人|当前|本轮)[^）)]{0,60}[）)]|@[^\s]+|\[(?:图片|表情|视频|语音|文件|动画表情)\]|https?:\/\/|www\.)/iu;
const STYLE_PROMPT_ECHO_PATTERN = /(?:如何评价|怎么评价|评价一下|锐评|什么水平|请结合|结合画面|可核实|解释它|发送了一张)/u;
// 认错过程不是群友语感，避免被模型学成每轮固定开场。
const STYLE_META_CORRECTION_PATTERN = /^\s*(?:(?:你说得对|你提醒得对)\s*[，,、:：]\s*)?(?:(?:我)?(?:上一轮|刚才|前面)理解错了|这条修正我收下|这点我收回)(?:\s*[：:，,、。；;!]\s*|\s+)/u;
const STYLE_NOISE_TERMS = new Set([
  '发送', '送了', '一张', '张图', '了一', '用户', '图片', '截图', '当前', '本轮',
  '消息', '结合', '画面', '核实',
]);
// 参考 Bot 可能播报新闻、贴链接或写长段说明。这些不是群友语感，
// 只保留短、无外链、非播报口吻的接话片段。
const REFERENCE_STYLE_EXAMPLE_PATTERN = /^(?!.*(?:https?:\/\/|www\.|【[^】]+】|来源[：:]|原标题|据报道|记者|今天|昨日|\d{2,}%|\d{4}年\d{1,2}月))/iu;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/gu;

function isUsableStyleText(value) {
  const text = normalizeLine(value, 180);
  return Boolean(text)
    && !STYLE_NOISE_PATTERN.test(text)
    && !STYLE_PROMPT_ECHO_PATTERN.test(text)
    && !STYLE_META_CORRECTION_PATTERN.test(text)
    && REFERENCE_STYLE_EXAMPLE_PATTERN.test(text);
}

function normalizeText(value, limit = 4_000) {
  return String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\u0000/gu, '')
    .trim()
    .slice(0, limit);
}

function normalizeLine(value, limit = 240) {
  return normalizeText(value, limit).replace(/\s+/gu, ' ').trim();
}

function stableMemberId(userId) {
  return createHash('sha256')
    .update(String(userId ?? 'anonymous'))
    .digest('hex')
    .slice(0, 6);
}

function participantLabel(senderName, userId) {
  const name = normalizeLine(senderName, 40) || `群成员-${stableMemberId(userId)}`;
  return `${name}（成员-${stableMemberId(userId)}）`;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function uniqueStrings(values, limit, itemLimit = 80) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeLine(value, itemLimit))
    .filter(Boolean))].slice(0, limit);
}

function isLikelyCommand(text) {
  return /^\s*\//u.test(String(text ?? ''));
}

function isSubstantive(text) {
  const normalized = normalizeLine(text, 300);
  return normalized.length >= 2 && !ACK_PATTERN.test(normalized);
}

function needsSummary(text) {
  const normalized = normalizeLine(text, 300);
  return normalized.length >= 4 && !ACK_PATTERN.test(normalized) && !isLikelyCommand(normalized);
}

function messageKindFor(event) {
  const value = String(event?.kind ?? '').trim();
  if (value) return value.slice(0, 24);
  if (event?.hasImage) return 'image';
  if (event?.hasVideo) return 'video';
  if (event?.hasForward) return 'forward';
  return 'text';
}

function sanitizeExample(value, limit = 120) {
  return normalizeLine(value, limit)
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/@[^\s()（）]+(?:[（(]\d+[)）])?/gu, ' ')
    .replace(/\b\d{6,}\b/gu, ' ')
    .replace(/(?:QQ|qq|群号|机器人)\s*[:：=]?\s*\d{5,}/gu, ' ')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/gu, ' ')
    .replace(/成员-[a-f0-9]{6,12}/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function hanBigrams(value) {
  const terms = new Set();
  for (const run of normalizeText(value, 2_000).match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) {
      const term = run.slice(index, index + 2);
      if (!STOP_TERMS.has(term)) terms.add(term);
    }
  }
  for (const term of normalizeText(value, 2_000).match(/[a-z][a-z0-9_-]{1,}/giu) ?? []) {
    if (!STOP_TERMS.has(term.toLowerCase())) terms.add(term.toLowerCase());
  }
  return [...terms].slice(0, 80);
}

function keywordTerms(value, limit = 16) {
  return hanBigrams(value).slice(0, limit);
}

function contentCharacters(value) {
  return [...new Set((normalizeText(value, 2_000).match(/[\p{Script=Han}]/gu) ?? [])
    .filter((character) => !STOP_CHARS.has(character)))].slice(0, 120);
}

function jaccard(left, right) {
  const a = new Set(left ?? []);
  const b = new Set(right ?? []);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function ratio(values, predicate) {
  return values.length ? values.filter(predicate).length / values.length : 0;
}

function sampleEvenly(rows, limit) {
  if (!Array.isArray(rows) || rows.length <= limit) return rows ?? [];
  const step = rows.length / limit;
  const sampled = [];
  for (let index = 0; index < limit; index += 1) {
    sampled.push(rows[Math.min(rows.length - 1, Math.floor(index * step))]);
  }
  return sampled;
}

function countEmoji(value) {
  return [...String(value ?? '').matchAll(EMOJI_PATTERN)].length;
}

function percent(value) {
  return Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);
}

function fitEventRows(rows, maxMessages, maxCharacters) {
  const fitted = [];
  let total = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const length = String(row.text ?? '').length;
    if (fitted.length >= maxMessages) break;
    if (fitted.length > 0 && total + length > maxCharacters) break;
    fitted.push(row);
    total += length;
  }
  return fitted.reverse();
}

function topicTitle(text) {
  const normalized = normalizeLine(text, 60);
  return normalized.length > 32 ? `${normalized.slice(0, 32)}…` : normalized;
}

function topicHistoryEntry(row) {
  if (row.author_type === 'own_bot') {
    return {
      role: 'assistant',
      content: `机器人回复：${normalizeText(row.text, 1_200)}`,
    };
  }
  const label = row.author_type === 'reference_bot'
    ? `参考Bot（成员-${stableMemberId(row.user_id)}）`
    : participantLabel(row.sender_name, row.user_id);
  const lines = [`当前发言人：${label}`];
  if (row.quoted_text) {
    lines.push(`引用消息内容：${normalizeText(row.quoted_text, 500)}`);
  }
  lines.push(`当前消息：${normalizeText(row.text, 1_200)}`);
  return { role: 'user', content: lines.join('\n') };
}

function parseStoredUserObservation(content) {
  const source = String(content ?? '');
  const speakerMatch = source.match(/(?:^|\n)当前发言人：([^\n]+)/u);
  const speaker = String(speakerMatch?.[1] ?? '').trim();
  const memberId = speaker.match(/（成员-([a-f0-9]{6,12})）/iu)?.[1] ?? '';
  const currentIndex = source.lastIndexOf('\n当前消息：');
  if (currentIndex < 0) return null;
  const text = source.slice(currentIndex + '\n当前消息：'.length).trim();
  if (!text) return null;
  const quoteIndex = source.lastIndexOf('\n引用消息内容：', currentIndex);
  const quoteText = quoteIndex >= 0
    ? source.slice(quoteIndex + '\n引用消息内容：'.length, currentIndex).trim()
    : '';
  const quotedAuthor = source.match(/(?:^|\n)引用消息作者：([^\n]+)/u)?.[1] ?? '';
  const quotedMemberId = String(quotedAuthor).match(/（成员-([a-f0-9]{6,12})）/iu)?.[1] ?? '';
  return {
    speakerName: speaker.replace(/（成员-[a-f0-9]{6,12}）/giu, '').trim(),
    memberId,
    text,
    quoteText,
    quotedAuthor: String(quotedAuthor).replace(/（成员-[a-f0-9]{6,12}）/giu, '').trim(),
    quotedMemberId,
  };
}

export class QqGroupMemory {
  constructor(options = {}) {
    this.databaseFilePath = String(options.databaseFilePath ?? '').trim();
    this.enabledGroups = new Set(
      [...(options.enabledGroups ?? [])].map((value) => String(value ?? '').trim()).filter(Boolean),
    );
    this.styleGroups = new Set(
      [...(options.styleGroups ?? this.enabledGroups)]
        .map((value) => String(value ?? '').trim())
        .filter(Boolean),
    );
    this.referenceBotsByGroup = new Map();
    for (const [groupId, userIds] of options.referenceBotsByGroup ?? []) {
      const normalizedGroupId = String(groupId ?? '').trim();
      const normalizedUserIds = [...new Set(
        (Array.isArray(userIds) ? userIds : (userIds instanceof Set ? [...userIds] : []))
          .map((value) => String(value ?? '').trim())
          .filter(Boolean),
      )];
      if (normalizedGroupId && normalizedUserIds.length) {
        this.referenceBotsByGroup.set(normalizedGroupId, new Set(normalizedUserIds));
      }
    }
    this.chatClient = options.chatClient ?? null;
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.topicIdleMs = Number(options.topicIdleMs ?? DEFAULT_TOPIC_IDLE_MS);
    this.topicKeepClosedMs = Number(options.topicKeepClosedMs ?? DEFAULT_TOPIC_KEEP_CLOSED_MS);
    this.maxActiveTopics = Math.max(1, Number(options.maxActiveTopics ?? DEFAULT_MAX_ACTIVE_TOPICS));
    this.contextMessages = Math.max(2, Number(options.contextMessages ?? DEFAULT_CONTEXT_MESSAGES));
    this.contextCharacters = Math.max(1_000, Number(options.contextCharacters ?? DEFAULT_CONTEXT_CHARACTERS));
    this.directContextMessages = Math.max(2, Number(options.directContextMessages ?? DEFAULT_DIRECT_CONTEXT_MESSAGES));
    this.directContextCharacters = Math.max(1_000, Number(options.directContextCharacters ?? DEFAULT_DIRECT_CONTEXT_CHARACTERS));
    this.styleRefreshHours = Math.max(1, Number(options.styleRefreshHours ?? DEFAULT_STYLE_REFRESH_HOURS));
    this.summaryIdleMs = Math.max(1_000, Number(options.summaryIdleMs ?? DEFAULT_SUMMARY_IDLE_MS));
    this.summaryTriggerMessages = Math.max(2, Number(options.summaryTriggerMessages ?? DEFAULT_SUMMARY_TRIGGER_MESSAGES));
    this.maxStyleExamples = Math.max(100, Number(options.maxStyleExamples ?? DEFAULT_MAX_STYLE_EXAMPLES));
    this.maxReferenceStyleExamples = Math.max(20, Number(options.maxReferenceStyleExamples ?? DEFAULT_MAX_REFERENCE_EXAMPLES));
    this.database = null;
    this.summaryTimers = new Map();
    this.pendingSummaries = new Map();
    this.styleRefreshTimer = null;
  }

  isEnabled(groupId) {
    return Boolean(String(groupId ?? '').trim() && this.enabledGroups.has(String(groupId).trim()));
  }

  isStyleEnabled(groupId) {
    return Boolean(String(groupId ?? '').trim() && this.styleGroups.has(String(groupId).trim()));
  }

  referenceBotIds(groupId) {
    return this.referenceBotsByGroup.get(String(groupId ?? '').trim()) ?? new Set();
  }

  ensureOpen() {
    if (this.database) return this.database;
    if (!this.databaseFilePath) throw new Error('QQ 群话题数据库路径不能为空');
    mkdirSync(path.dirname(this.databaseFilePath), { recursive: true });
    this.database = new DatabaseSync(this.databaseFilePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS qq_group_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT '',
        sender_name TEXT NOT NULL DEFAULT '',
        message_id TEXT NOT NULL DEFAULT '',
        quoted_message_id TEXT NOT NULL DEFAULT '',
        quoted_user_id TEXT NOT NULL DEFAULT '',
        quoted_text TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'text',
        author_type TEXT NOT NULL CHECK(author_type IN ('human', 'own_bot', 'reference_bot', 'peer_bot')),
        topic_id INTEGER,
        topic_confidence REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        inserted_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS qq_group_events_message_id
        ON qq_group_events(group_id, message_id)
        WHERE message_id <> '';
      CREATE INDEX IF NOT EXISTS qq_group_events_group_id_id
        ON qq_group_events(group_id, id);
      CREATE INDEX IF NOT EXISTS qq_group_events_group_created
        ON qq_group_events(group_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS qq_group_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        keywords_json TEXT NOT NULL DEFAULT '[]',
        participants_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('open', 'closed')),
        confidence REAL NOT NULL DEFAULT 0,
        summary_through_event_id INTEGER NOT NULL DEFAULT 0,
        human_message_count INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        closed_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS qq_group_topics_active
        ON qq_group_topics(group_id, status, last_activity_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS qq_group_topic_fts USING fts5(
        group_id UNINDEXED,
        topic_id UNINDEXED,
        terms,
        title
      );

      CREATE TABLE IF NOT EXISTS qq_group_style_profiles (
        group_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        profile_json TEXT NOT NULL,
        source_count INTEGER NOT NULL,
        source_start_at INTEGER NOT NULL,
        source_end_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS qq_group_style_examples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        author_type TEXT NOT NULL,
        sender_label TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        terms TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS qq_group_style_examples_group
        ON qq_group_style_examples(group_id, author_type, id DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS qq_group_style_fts USING fts5(
        group_id UNINDEXED,
        example_id UNINDEXED,
        terms,
        text
      );
    `);
    this.syncTopicFts();
    return this.database;
  }

  indexTopicFts(topicId) {
    const database = this.ensureOpen();
    const normalizedTopicId = Number(topicId);
    if (!Number.isInteger(normalizedTopicId)) return;
    const topic = database.prepare(`
      SELECT id, group_id, title, keywords_json
      FROM qq_group_topics WHERE id = ?
    `).get(normalizedTopicId);
    database.prepare('DELETE FROM qq_group_topic_fts WHERE topic_id = ?').run(normalizedTopicId);
    if (!topic) return;
    const terms = uniqueStrings([
      ...parseJsonArray(topic.keywords_json),
      ...hanBigrams(topic.title),
    ], 80, 24).join(' ');
    database.prepare(`
      INSERT INTO qq_group_topic_fts(group_id, topic_id, terms, title)
      VALUES (?, ?, ?, ?)
    `).run(String(topic.group_id), normalizedTopicId, terms, normalizeLine(topic.title, 120));
  }

  syncTopicFts() {
    const database = this.database;
    if (!database) return;
    while (true) {
      const missing = database.prepare(`
        SELECT t.id
        FROM qq_group_topics AS t
        WHERE NOT EXISTS (
          SELECT 1 FROM qq_group_topic_fts AS f
          WHERE CAST(f.topic_id AS INTEGER) = t.id
        )
        LIMIT 500
      `).all();
      if (missing.length === 0) break;
      for (const row of missing) this.indexTopicFts(Number(row.id));
    }
  }

  begin() {
    this.ensureOpen().exec('BEGIN IMMEDIATE');
  }

  commit() {
    this.ensureOpen().exec('COMMIT');
  }

  rollback() {
    try {
      this.ensureOpen().exec('ROLLBACK');
    } catch {
      // Transaction may already have been rolled back by SQLite.
    }
  }

  authorTypeFor(groupId, userId, explicitType = '') {
    if (explicitType) return explicitType;
    const normalized = String(userId ?? '').trim();
    return this.referenceBotIds(groupId).has(normalized) ? 'reference_bot' : 'human';
  }

  recordEvent(event = {}) {
    const groupId = String(event.groupId ?? '').trim();
    const text = normalizeText(event.text, 4_000);
    if (!groupId || !text) return null;
    const database = this.ensureOpen();
    const messageId = normalizeLine(event.messageId, 160);
    if (messageId) {
      const existing = database.prepare(`
        SELECT id, topic_id, topic_confidence
        FROM qq_group_events
        WHERE group_id = ? AND message_id = ?
      `).get(groupId, messageId);
      if (existing) {
        return this.eventResolution(Number(existing.id));
      }
    }
    const createdAt = Number.isFinite(Number(event.createdAt))
      ? Number(event.createdAt)
      : this.now();
    const authorType = this.authorTypeFor(groupId, event.userId, event.authorType);
    const kind = messageKindFor(event);
    const result = database.prepare(`
      INSERT INTO qq_group_events(
        group_id, conversation_id, user_id, sender_name, message_id,
        quoted_message_id, quoted_user_id, quoted_text, text, kind,
        author_type, created_at, inserted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      groupId,
      `group:${groupId}`,
      normalizeLine(event.userId, 80),
      normalizeLine(event.senderName, 80),
      messageId,
      normalizeLine(event.quotedMessageId, 160),
      normalizeLine(event.quotedUserId, 80),
      normalizeText(event.quotedText, 1_000),
      text,
      kind,
      authorType,
      createdAt,
      this.now(),
    );
    const eventId = Number(result.lastInsertRowid);
    let assignment = { topicId: null, confidence: 0, status: 'ambiguous' };
    if (event.assignTopic !== false && authorType !== 'own_bot') {
      assignment = this.assignTopic(eventId, event);
    } else if (event.topicId) {
      assignment = this.attachEventToTopic(eventId, Number(event.topicId), Number(event.confidence ?? 1));
    }
    if (event.scheduleSummary !== false && assignment.topicId && authorType !== 'own_bot') {
      this.scheduleSummary(Number(assignment.topicId));
    }
    return {
      eventId,
      topicId: assignment.topicId,
      confidence: assignment.confidence,
      status: assignment.status,
    };
  }

  eventResolution(eventId) {
    const row = this.ensureOpen().prepare(`
      SELECT e.id, e.topic_id, e.topic_confidence, t.human_message_count
      FROM qq_group_events AS e
      LEFT JOIN qq_group_topics AS t ON t.id = e.topic_id
      WHERE e.id = ?
    `).get(eventId);
    if (!row) return null;
    const confidence = Number(row.topic_confidence ?? 0);
    return {
      eventId: Number(row.id),
      topicId: row.topic_id ? Number(row.topic_id) : null,
      confidence,
      status: Number(row.human_message_count ?? 0) >= 2 && confidence >= TOPIC_MATCH_THRESHOLD
        ? 'matched'
        : 'ambiguous',
    };
  }

  activeTopics(groupId, now = this.now()) {
    this.closeStaleTopics(groupId, now);
    return this.ensureOpen().prepare(`
      SELECT *
      FROM qq_group_topics
      WHERE group_id = ? AND status = 'open' AND last_activity_at >= ?
      ORDER BY last_activity_at DESC
      LIMIT ?
    `).all(groupId, now - this.topicIdleMs, this.maxActiveTopics);
  }

  candidateTopics(groupId, now = this.now()) {
    this.closeStaleTopics(groupId, now);
    return this.ensureOpen().prepare(`
      SELECT *
      FROM qq_group_topics
      WHERE group_id = ?
        AND (
          status = 'open'
          OR (status = 'closed' AND closed_at >= ?)
        )
      ORDER BY
        CASE WHEN status = 'open' THEN 0 ELSE 1 END,
        last_activity_at DESC
      LIMIT ?
    `).all(groupId, now - this.topicKeepClosedMs, this.maxActiveTopics * 3);
  }

  topicFtsBoost(groupId, topicIds, eventTerms) {
    if (!topicIds.length || eventTerms.length === 0) return new Map();
    const match = eventTerms
      .slice(0, 20)
      .map((term) => `"${String(term).replaceAll('"', ' ')}"`)
      .join(' OR ');
    if (!match) return new Map();
    try {
      const rows = this.ensureOpen().prepare(`
        SELECT topic_id
        FROM qq_group_topic_fts
        WHERE group_id = ? AND qq_group_topic_fts MATCH ?
        LIMIT 100
      `).all(String(groupId ?? '').trim(), match);
      return new Map(rows.map((row) => [Number(row.topic_id), 0.06]));
    } catch {
      return new Map();
    }
  }

  closeStaleTopics(groupId, now = this.now()) {
    const database = this.ensureOpen();
    database.prepare(`
      UPDATE qq_group_topics
      SET status = 'closed', closed_at = ?, updated_at = ?
      WHERE group_id = ? AND status = 'open' AND last_activity_at < ?
    `).run(now, now, groupId, now - this.topicIdleMs);
    const staleClosed = database.prepare(`
      SELECT id FROM qq_group_topics
      WHERE group_id = ? AND status = 'closed' AND closed_at > 0 AND closed_at < ?
    `).all(groupId, now - this.topicKeepClosedMs);
    if (staleClosed.length) {
      const deleteTopic = database.prepare('DELETE FROM qq_group_topics WHERE id = ?');
      const detachEvents = database.prepare(`
        UPDATE qq_group_events SET topic_id = NULL, topic_confidence = 0 WHERE topic_id = ?
      `);
      const deleteFts = database.prepare('DELETE FROM qq_group_topic_fts WHERE topic_id = ?');
      for (const row of staleClosed) {
        detachEvents.run(Number(row.id));
        deleteFts.run(Number(row.id));
        deleteTopic.run(Number(row.id));
      }
    }
    const open = database.prepare(`
      SELECT id FROM qq_group_topics
      WHERE group_id = ? AND status = 'open'
      ORDER BY last_activity_at DESC
    `).all(groupId);
    if (open.length > this.maxActiveTopics) {
      const close = database.prepare(`
        UPDATE qq_group_topics
        SET status = 'closed', closed_at = ?, updated_at = ?
        WHERE id = ?
      `);
      for (const row of open.slice(this.maxActiveTopics)) {
        close.run(now, now, Number(row.id));
      }
    }
  }

  assignTopic(eventId, event) {
    const database = this.ensureOpen();
    const row = database.prepare(`
      SELECT id, group_id, user_id, quoted_message_id, quoted_user_id, quoted_text, text, author_type, created_at
      FROM qq_group_events WHERE id = ?
    `).get(eventId);
    if (!row) return { topicId: null, confidence: 0, status: 'ambiguous' };
    const groupId = String(row.group_id);
    const createdAt = Number(row.created_at);
    let exactTopicId = null;
    if (row.quoted_message_id) {
      const quoted = database.prepare(`
        SELECT topic_id FROM qq_group_events
        WHERE group_id = ? AND message_id = ? AND topic_id IS NOT NULL
        ORDER BY id DESC LIMIT 1
      `).get(groupId, row.quoted_message_id);
      exactTopicId = quoted?.topic_id ? Number(quoted.topic_id) : null;
    }
    if (!exactTopicId && row.quoted_text) {
      const quoted = database.prepare(`
        SELECT topic_id FROM qq_group_events
        WHERE group_id = ? AND topic_id IS NOT NULL AND quoted_text = ''
          AND text = ?
        ORDER BY id DESC LIMIT 1
      `).get(groupId, normalizeText(row.quoted_text, 1_000));
      exactTopicId = quoted?.topic_id ? Number(quoted.topic_id) : null;
    }
    if (exactTopicId) {
      return this.attachEventToTopic(eventId, exactTopicId, 1);
    }
    const topics = this.candidateTopics(groupId, createdAt);
    const eventTerms = keywordTerms(row.text);
    const rowUser = String(row.user_id ?? '').trim();
    const ftsBoosts = this.topicFtsBoost(
      groupId,
      topics.map((topic) => Number(topic.id)),
      eventTerms,
    );
    let best = null;
    let secondScore = 0;
    for (const topic of topics) {
      const keywords = parseJsonArray(topic.keywords_json);
      const participants = parseJsonArray(topic.participants_json);
      const lexical = jaccard(eventTerms, keywords);
      const eventCharacters = contentCharacters(row.text);
      const topicCharacters = contentCharacters(`${topic.title ?? ''} ${keywords.join(' ')}`);
      const sharedCharacterCount = eventCharacters
        .filter((character) => topicCharacters.includes(character)).length;
      // 单个“新/上/这”之类的常用字不足以证明同话题；至少两个实词字，
      // 再计算字面重合度，避免把时间、地点等单字巧合当成串话题依据。
      const charLexical = sharedCharacterCount >= 2
        ? jaccard(eventCharacters, topicCharacters)
        : 0;
      const previous = Number(topic.last_activity_at);
      const recency = Math.max(0, 1 - (createdAt - previous) / this.topicIdleMs);
      let sameSenderRecent = 0;
      if (rowUser) {
        const lastEvent = database.prepare(`
          SELECT created_at FROM qq_group_events
          WHERE topic_id = ? AND user_id = ? AND id < ?
          ORDER BY id DESC LIMIT 1
        `).get(Number(topic.id), rowUser, eventId);
        if (lastEvent) {
          sameSenderRecent = Math.max(
            0,
            1 - (createdAt - Number(lastEvent.created_at)) / SAME_SENDER_CONTINUATION_MS,
          );
        }
      }
      const participantBoost = rowUser && participants.includes(rowUser) ? 1 : 0;
      const quotedParticipant = row.quoted_user_id
        && participants.includes(String(row.quoted_user_id)) ? 1 : 0;
      const timeProximity = Math.max(
        0,
        1 - Math.max(0, createdAt - previous) / (2 * MINUTE_MS),
      );
      // Participant and same-sender boosts only strengthen an existing lexical
      // or quote link. They must not merge a completely new subject into the
      // previous topic just because the same person speaks again.
      const hasLocalLink = lexical > 0
        || charLexical >= 0.03
        || quotedParticipant > 0;
      const strongLexicalBoost = lexical >= 0.08 || charLexical >= 0.1 ? 0.22 : 0;
      let score = Math.min(0.99,
        lexical * 0.5
        + charLexical * 0.2
        + recency * 0.3
        + timeProximity * 0.15
        + sameSenderRecent * 0.12
        + participantBoost * 0.05
        + quotedParticipant * 0.15
        + strongLexicalBoost
        + (ftsBoosts.get(Number(topic.id)) ?? 0),
      );
      // 同一发言者紧跟自己的上一句，是多人混聊里最强的非引用信号。
      // 仍要求有一点词面延续，避免把同一个人突然切换的新话题硬接过去。
      if (sameSenderRecent >= 0.5 && lexical >= 0.08) {
        score = Math.max(score, Math.min(0.92, 0.82 + sameSenderRecent * 0.1));
      }
      if (topic.status === 'closed') score = Math.max(0, score - CLOSED_TOPIC_PENALTY);
      if (!hasLocalLink) score = 0;
      if (!best || score > best.score) {
        if (best) secondScore = Math.max(secondScore, best.score);
        best = { topic, score };
      } else {
        secondScore = Math.max(secondScore, score);
      }
    }
    if (best && best.score >= TOPIC_ASSIGN_THRESHOLD
      && (best.score - secondScore >= TOPIC_AMBIGUITY_MARGIN || topics.length === 1)) {
      return this.attachEventToTopic(eventId, Number(best.topic.id), best.score);
    }
    if (!isSubstantive(row.text)) {
      // 附和、笑声和单字接龙不单独开话题；能贴到最近一场讨论就只作为
      // 低置信上下文，贴不上则保持无话题，避免噪声污染主动接话。
      if (best) return this.attachEventToTopic(eventId, Number(best.topic.id), Math.min(best.score, 0.5));
      return { topicId: null, confidence: 0, status: 'ambiguous' };
    }
    const now = Number(row.created_at);
    const title = topicTitle(row.text);
    const summary = '';
    const keywords = uniqueStrings(eventTerms, 16, 24);
    const participants = rowUser ? [rowUser] : [];
    const result = database.prepare(`
      INSERT INTO qq_group_topics(
        group_id, title, summary, keywords_json, participants_json, status,
        confidence, human_message_count, message_count, started_at,
        last_activity_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'open', 0.35, 1, 1, ?, ?, ?)
    `).run(
      groupId,
      title,
      summary,
      JSON.stringify(keywords),
      JSON.stringify(participants),
      now,
      now,
      now,
    );
    const topicId = Number(result.lastInsertRowid);
    database.prepare(`
      UPDATE qq_group_events SET topic_id = ?, topic_confidence = ? WHERE id = ?
    `).run(topicId, 0.35, eventId);
    this.indexTopicFts(topicId);
    return { topicId, confidence: 0.35, status: 'ambiguous' };
  }

  attachEventToTopic(eventId, topicId, confidence) {
    const database = this.ensureOpen();
    const event = database.prepare(`
      SELECT group_id, user_id, sender_name, text, author_type, created_at
      FROM qq_group_events WHERE id = ?
    `).get(eventId);
    const topic = database.prepare('SELECT * FROM qq_group_topics WHERE id = ?').get(topicId);
    if (!event || !topic) return { topicId: null, confidence: 0, status: 'ambiguous' };
    const keywords = uniqueStrings([
      ...parseJsonArray(topic.keywords_json),
      ...keywordTerms(event.text),
    ], 32, 24);
    const participants = uniqueStrings([
      ...parseJsonArray(topic.participants_json),
      ...(event.user_id ? [String(event.user_id)] : []),
    ], 20, 80);
    // Only real humans satisfy the “two human messages before active reply”
    // gate. Reference/peer bots may contribute style and context, but cannot
    // make a one-person topic look established.
    const humanIncrement = event.author_type === 'human' ? 1 : 0;
    let normalizedConfidence = Math.max(Number(topic.confidence ?? 0), Number(confidence ?? 0));
    const humanCount = Number(topic.human_message_count ?? 0) + humanIncrement;
    if (humanCount >= 2 && event.author_type === 'human') {
      // Two real turns attached to the same local thread are enough evidence
      // that this is the active conversation. Exact quote/same-sender keep
      // their stronger scores; weak lexical joins settle at 0.68.
      normalizedConfidence = Math.max(normalizedConfidence, 0.68);
    }
    database.prepare(`
      UPDATE qq_group_events SET topic_id = ?, topic_confidence = ? WHERE id = ?
    `).run(topicId, normalizedConfidence, eventId);
    database.prepare(`
      UPDATE qq_group_topics
      SET keywords_json = ?, participants_json = ?, confidence = ?,
          human_message_count = human_message_count + ?,
          message_count = message_count + 1,
          status = 'open', closed_at = 0,
          last_activity_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(keywords),
      JSON.stringify(participants),
      normalizedConfidence,
      humanIncrement,
      Number(event.created_at),
      this.now(),
      topicId,
    );
    this.indexTopicFts(topicId);
    const status = humanCount >= 2 && normalizedConfidence >= TOPIC_MATCH_THRESHOLD
      ? 'matched'
      : 'ambiguous';
    return { topicId, confidence: normalizedConfidence, status };
  }

  getEventState(groupId, messageId) {
    const normalizedGroupId = String(groupId ?? '').trim();
    const normalizedMessageId = String(messageId ?? '').trim();
    if (!normalizedGroupId || !normalizedMessageId) return null;
    const row = this.ensureOpen().prepare(`
      SELECT id FROM qq_group_events
      WHERE group_id = ? AND message_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(normalizedGroupId, normalizedMessageId);
    return row ? this.eventResolution(Number(row.id)) : null;
  }

  buildTopicHistory(topicId, currentEventId, { maxMessages, maxCharacters } = {}) {
    const database = this.ensureOpen();
    const rows = database.prepare(`
      SELECT id, user_id, sender_name, quoted_text, text, author_type, created_at, topic_id
      FROM qq_group_events
      WHERE topic_id = ? AND id < ?
      ORDER BY id DESC
      LIMIT 400
    `).all(Number(topicId), Number(currentEventId));
    // A quote can point at a message that was later re-assigned to another
    // topic. Keep that one directly-linked neighbor as evidence, but never
    // pull the whole adjacent conversation into this topic.
    const current = database.prepare(`
      SELECT quoted_message_id FROM qq_group_events WHERE id = ?
    `).get(Number(currentEventId));
    if (current?.quoted_message_id) {
      const quoted = database.prepare(`
        SELECT id, user_id, sender_name, quoted_text, text, author_type, created_at, topic_id
        FROM qq_group_events
        WHERE group_id = (SELECT group_id FROM qq_group_events WHERE id = ?)
          AND message_id = ?
        ORDER BY id DESC LIMIT 1
      `).get(Number(currentEventId), String(current.quoted_message_id));
      if (quoted && !rows.some((row) => Number(row.id) === Number(quoted.id))) {
        rows.push(quoted);
      }
    }
    rows.sort((left, right) => Number(left.id) - Number(right.id));
    return fitEventRows(rows, maxMessages, maxCharacters).map(topicHistoryEntry);
  }

  resolveReplyContext({ groupId, messageId, allowDirectFallback = false } = {}) {
    const normalizedGroupId = String(groupId ?? '').trim();
    if (!this.isEnabled(normalizedGroupId)) return null;
    const state = this.getEventState(normalizedGroupId, messageId);
    if (!state) return null;
    const database = this.ensureOpen();
    const topic = state.topicId
      ? database.prepare('SELECT * FROM qq_group_topics WHERE id = ?').get(state.topicId)
      : null;
    const matched = Boolean(topic
      && state.status === 'matched'
      && Number(topic.human_message_count ?? 0) >= 2);
    if (matched) {
      const history = this.buildTopicHistory(Number(topic.id), Number(state.eventId), {
        maxMessages: this.contextMessages,
        maxCharacters: this.contextCharacters,
      });
      const participants = parseJsonArray(topic.participants_json);
      const prompt = [
        '【当前群聊话题】',
        `话题：${topic.title || '未命名话题'}`,
        topic.summary ? `话题摘要：${topic.summary}` : '',
        participants.length ? `参与成员数：${participants.length}` : '',
        '只围绕这个话题接当前这句话。不要把旁边另一场讨论的人物、事实或结论混进来；话题摘要只作背景，不逐句复述。',
        '如果当前消息明显转向新话题，以当前原话为准，不为了维持旧话题硬接。',
      ].filter(Boolean).join('\n');
      return {
        status: 'matched',
        topicId: Number(topic.id),
        confidence: state.confidence,
        contextMessages: history.length,
        contextCharacters: history.reduce((sum, message) => sum + String(message.content ?? '').length, 0),
        history,
        prompt,
      };
    }
    if (!allowDirectFallback) {
      return {
        status: 'ambiguous',
        topicId: state.topicId,
        confidence: state.confidence,
        contextMessages: 0,
        contextCharacters: 0,
        history: [],
        prompt: '',
      };
    }
    const rows = database.prepare(`
      SELECT id, user_id, sender_name, quoted_text, text, author_type, created_at, topic_id
      FROM qq_group_events
      WHERE group_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(normalizedGroupId, this.directContextMessages).reverse();
    const history = fitEventRows(
      rows.filter((row) => Number(row.id) !== Number(state.eventId)),
      this.directContextMessages,
      this.directContextCharacters,
    )
      .map(topicHistoryEntry);
    return {
      status: 'direct-fallback',
      topicId: state.topicId,
      confidence: state.confidence,
      contextMessages: history.length,
      contextCharacters: history.reduce((sum, message) => sum + String(message.content ?? '').length, 0),
      history,
      prompt: [
        '【当前语境边界】',
        '当前消息没有足够证据明确落到一个既有话题。只按最近几条消息和当前原话回答，不要引用未确认的旧话题、旧梗或旧结论。',
      ].join('\n'),
    };
  }

  recordOwnReply({ groupId, topicId, text, messageId } = {}) {
    const normalizedGroupId = String(groupId ?? '').trim();
    const normalizedText = normalizeText(text, 4_000);
    if (!this.isEnabled(normalizedGroupId) || !normalizedText) return null;
    return this.recordEvent({
      groupId: normalizedGroupId,
      userId: 'bot',
      senderName: '机器人',
      messageId: messageId || `bot:${normalizedGroupId}:${this.now()}`,
      text: normalizedText,
      authorType: 'own_bot',
      topicId: topicId || null,
      scheduleSummary: false,
      assignTopic: false,
    });
  }

  scheduleSummary(topicId, { idleOnly = false } = {}) {
    if (!this.chatClient || !Number.isInteger(Number(topicId))) return;
    const normalizedTopicId = Number(topicId);
    const topic = this.ensureOpen().prepare(`
      SELECT * FROM qq_group_topics WHERE id = ? AND status = 'open'
    `).get(normalizedTopicId);
    if (!topic) return;
    const unsummarized = Number(this.ensureOpen().prepare(`
      SELECT COUNT(*) AS count FROM qq_group_events
      WHERE topic_id = ? AND id > ? AND author_type <> 'own_bot'
    `).get(normalizedTopicId, Number(topic.summary_through_event_id)).count);
    if (!idleOnly && unsummarized >= this.summaryTriggerMessages) {
      void this.summarizeTopic(normalizedTopicId);
      return;
    }
    if (unsummarized === 0) return;
    clearTimeout(this.summaryTimers.get(normalizedTopicId));
    const timer = setTimeout(() => {
      this.summaryTimers.delete(normalizedTopicId);
      void this.summarizeTopic(normalizedTopicId);
    }, this.summaryIdleMs);
    timer.unref?.();
    this.summaryTimers.set(normalizedTopicId, timer);
  }

  async summarizeTopic(topicId) {
    if (!this.chatClient || this.pendingSummaries.has(topicId)) return false;
    const database = this.ensureOpen();
    const topic = database.prepare(`
      SELECT * FROM qq_group_topics WHERE id = ? AND status = 'open'
    `).get(topicId);
    if (!topic) return false;
    const rows = database.prepare(`
      SELECT id, sender_name, user_id, text, author_type
      FROM qq_group_events
      WHERE topic_id = ? AND id > ? AND author_type <> 'own_bot'
      ORDER BY id ASC
      LIMIT 24
    `).all(topicId, Number(topic.summary_through_event_id));
    if (rows.length === 0) return false;
    const throughId = Number(rows.at(-1).id);
    const input = [
      `当前话题标题：${topic.title || '未命名'}`,
      `已有摘要：${topic.summary || '（暂无）'}`,
      '新增发言：',
      ...rows.map((row) => {
        const label = row.author_type === 'reference_bot' ? '参考Bot' : (row.sender_name || '群友');
        return `${label}：${normalizeText(row.text, 800)}`;
      }),
      '请只总结这段讨论正在聊什么、各方立场或关键事实、是否已经转向新话题。不要评价发言者，不要输出昵称或未出现在发言中的事实。',
    ].join('\n');
    const task = Promise.resolve()
      .then(() => this.chatClient.complete([], input, {
        systemPrompt: [
          '你是 QQ 群聊的本地话题整理器。输出严格 JSON：{"title":"不超过32字","summary":"不超过420字","keywords":["2-16个短词"],"status":"open|closed"}。',
          '只整理输入中真实出现的讨论；不要把玩笑写成现实事实；不要补充外部知识；不要复述原句。',
        ].join('\n'),
        maxTokens: 500,
        temperature: 0.1,
        usageSource: 'group-topic-summary',
        timeoutMs: 45_000,
        thinking: { type: 'disabled' },
      }))
      .then((raw) => {
        const text = String(raw ?? '').trim();
        const match = text.match(/\{[\s\S]*\}/u);
        if (!match) return false;
        const parsed = JSON.parse(match[0]);
        const title = normalizeLine(parsed.title, 48);
        const summary = normalizeText(parsed.summary, 700);
        const keywords = uniqueStrings(parsed.keywords, 16, 24);
        const status = parsed.status === 'closed' ? 'closed' : 'open';
        if (!title && !summary) return false;
        const now = this.now();
        const result = database.prepare(`
          UPDATE qq_group_topics
          SET title = COALESCE(NULLIF(?, ''), title),
              summary = COALESCE(NULLIF(?, ''), summary),
              keywords_json = ?,
              status = ?,
              summary_through_event_id = ?,
              closed_at = CASE WHEN ? = 'closed' THEN ? ELSE closed_at END,
              updated_at = ?
          WHERE id = ? AND summary_through_event_id = ?
        `).run(
          title,
          summary,
          JSON.stringify(keywords),
          status,
          throughId,
          status,
          now,
          now,
          topicId,
          Number(topic.summary_through_event_id),
        );
        if (Number(result.changes) > 0) this.indexTopicFts(topicId);
        return Number(result.changes) > 0;
      })
      .catch((error) => {
        this.logger.warn?.(`QQ 群话题摘要失败：topic=${topicId} ${error.message}`);
        return false;
      })
      .finally(() => {
        if (this.pendingSummaries.get(topicId) === task) this.pendingSummaries.delete(topicId);
      });
    this.pendingSummaries.set(topicId, task);
    return task;
  }

  rebuildStyleProfile(groupId) {
    const normalizedGroupId = String(groupId ?? '').trim();
    if (!normalizedGroupId || !this.isStyleEnabled(normalizedGroupId)) return false;
    const database = this.ensureOpen();
    const humanWhere = `group_id = ? AND author_type = 'human' AND text <> '' AND text NOT LIKE '/%'`;
    const stats = database.prepare(`
      SELECT COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM qq_group_events WHERE ${humanWhere}
    `).get(normalizedGroupId);
    const sourceCount = Number(stats?.count ?? 0);
    if (sourceCount < MIN_STYLE_SOURCE_MESSAGES) return false;
    const humanRows = database.prepare(`
      SELECT id, user_id, sender_name, quoted_user_id, text, author_type, created_at
      FROM qq_group_events
      WHERE ${humanWhere}
      ORDER BY id ASC
    `).all(normalizedGroupId);
    const lengths = humanRows.map((row) => normalizeText(row.text, 2_000).length);
    const referenceIds = [...this.referenceBotIds(normalizedGroupId)];
    const referencePlaceholders = referenceIds.map(() => '?').join(', ');
    const referenceCount = referenceIds.length
      ? Number(database.prepare(`
        SELECT COUNT(*) AS count FROM qq_group_events
        WHERE group_id = ? AND author_type = 'reference_bot'
          AND user_id IN (${referencePlaceholders})
      `).get(normalizedGroupId, ...referenceIds).count)
      : 0;
    const repeated = database.prepare(`
      SELECT text, COUNT(*) AS count
      FROM qq_group_events
      WHERE ${humanWhere} AND length(text) BETWEEN 2 AND 24
      GROUP BY text HAVING COUNT(*) >= 3
      ORDER BY count DESC LIMIT 16
    `).all(normalizedGroupId).map((row) => ({ text: sanitizeExample(row.text, 24), count: Number(row.count) }))
      .filter((row) => row.text && !SAFE_EXAMPLE_PATTERN.test(row.text) && isUsableStyleText(row.text));
    // 覆盖全部可用历史而不是只取最近样本；数量过大时按时间顺序等距抽样，
    // 省掉最早/中段/最近任一时期的语感断层。
    const sample = sampleEvenly(
      humanRows.filter((row) => {
        const length = normalizeText(row.text, 2_000).length;
        return length >= 4 && length <= 120;
      }),
      3_000,
    );
    const termCounts = new Map();
    for (const row of sample) {
      for (const term of hanBigrams(row.text)) {
        termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
      }
    }
    const commonTerms = [...termCounts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 18)
      .map(([term, count]) => ({ term, count }))
      .filter((row) => !SAFE_EXAMPLE_PATTERN.test(row.term)
        && !STYLE_NOISE_TERMS.has(row.term)
        && !STYLE_NOISE_PATTERN.test(row.term)
        && !STYLE_PROMPT_ECHO_PATTERN.test(row.term));
    const relationships = database.prepare(`
      SELECT user_id, quoted_user_id, COUNT(*) AS count
      FROM qq_group_events
      WHERE ${humanWhere} AND quoted_user_id <> '' AND user_id <> quoted_user_id
      GROUP BY user_id, quoted_user_id
      ORDER BY count DESC LIMIT 10
    `).all(normalizedGroupId).map((row) => ({
      from: String(row.user_id),
      to: String(row.quoted_user_id),
      count: Number(row.count),
    }));
    const texts = humanRows.map((row) => normalizeText(row.text, 2_000));
    const medianLength = median(lengths);
    const p75Length = percentile(lengths, 0.75);
    const shortRatio = ratio(lengths, (length) => length <= 20);
    const questionRatio = ratio(texts, (text) => /[?？]/u.test(text));
    const exclamationRatio = ratio(texts, (text) => /[!！]/u.test(text));
    const ellipsisRatio = ratio(texts, (text) => /(?:…|\.{3,})/u.test(text));
    const emojiRatio = ratio(texts, (text) => countEmoji(text) > 0);
    const ackRatio = ratio(texts, (text) => ACK_PATTERN.test(text));
    const quotedReplyRatio = ratio(humanRows, (row) => Boolean(row.quoted_user_id));
    const multiSentenceRatio = ratio(texts, (text) => (
      text.split(/[。！？!?；;\n]+/u).filter((part) => part.trim()).length >= 2
    ));
    const styleRules = [
      `真实群聊中位长度约 ${medianLength} 字，75% 的发言不超过 ${p75Length} 字；默认先短接一句，再决定是否补充。`,
      `约 ${percent(shortRatio)}% 的发言不超过 20 字，约 ${percent(multiSentenceRatio)}% 会分成两句以上；不要为了完整把一句话扩写成说明文。`,
      questionRatio >= 0.35
        ? `约 ${percent(questionRatio)}% 的发言带问号，群里直接提问较多；可以先给判断或结论，再补依据。`
        : `约 ${percent(questionRatio)}% 的发言带问号，群里陈述、接梗和吐槽更多；优先顺着当前关系和情绪说，不急着科普。`,
      exclamationRatio >= 0.2 || ellipsisRatio >= 0.15
        ? `群友常用${exclamationRatio >= 0.2 ? '感叹号和短促语气' : ''}${exclamationRatio >= 0.2 && ellipsisRatio >= 0.15 ? '、' : ''}${ellipsisRatio >= 0.15 ? '省略号和拖长语气' : ''}来表达态度；按语义使用，不要每句都加。`
        : '群里标点使用克制，多数时候靠短句和语气词接话，不要滥用感叹号或省略号。',
      emojiRatio >= 0.08
        ? `约 ${percent(emojiRatio)}% 的发言带 emoji；可以少量使用群里常见的表情语气，但不要用表情替代回答。`
        : '群里很少用 emoji，默认用文字和语气接话，不要每句塞表情。',
      quotedReplyRatio >= 0.25
        ? `约 ${percent(quotedReplyRatio)}% 的发言通过引用/回复接话；群聊里经常直接对着上一句吐槽或补充，少写完整称呼和客套转折。`
        : '群里多数消息顺着上下文直接说，不反复复述对方原话或补完整称呼。',
      ackRatio >= 0.15
        ? `约 ${percent(ackRatio)}% 是“确实/笑死/6/草”这类极短接话；允许用一两个字的真实反应接梗，不必每次都给完整观点。`
        : '短接话不是主流；没有有效信息时宁可只说一句判断，也不要硬凑附和。',
    ];
    if (repeated.length) {
      styleRules.push('群内有复读和固定短句的玩笑机制；只在语义贴题时复用其中一句，不复读整段，也不把群梗当现实事实。');
    }
    if (relationships.length) {
      styleRules.push('群友之间会用短句互损、拆台和接梗；互损只围绕当前话题或具体说法，不编造现实关系。');
    }
    const profile = {
      version: 2,
      groupId: normalizedGroupId,
      sourceCount,
      referenceCount,
      medianLength,
      p75Length,
      shortRatio: Number(shortRatio.toFixed(3)),
      questionRatio: Number(questionRatio.toFixed(3)),
      exclamationRatio: Number(exclamationRatio.toFixed(3)),
      ellipsisRatio: Number(ellipsisRatio.toFixed(3)),
      emojiRatio: Number(emojiRatio.toFixed(3)),
      ackRatio: Number(ackRatio.toFixed(3)),
      quotedReplyRatio: Number(quotedReplyRatio.toFixed(3)),
      multiSentenceRatio: Number(multiSentenceRatio.toFixed(3)),
      styleRules,
      styleCard: {
        rhythm: `中位 ${medianLength} 字，短句占 ${percent(shortRatio)}%。`,
        punctuation: `问号 ${percent(questionRatio)}%，感叹号 ${percent(exclamationRatio)}%，省略号 ${percent(ellipsisRatio)}%。`,
        reactions: `极短接话 ${percent(ackRatio)}%，emoji ${percent(emojiRatio)}%。`,
        threading: `引用接话 ${percent(quotedReplyRatio)}%。`,
      },
      commonTerms,
      repeatedPhrases: repeated.map((row) => row.text),
      relationships,
      referenceBotIds: referenceIds,
      updatedAt: this.now(),
    };
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM qq_group_style_examples WHERE group_id = ?').run(normalizedGroupId);
      database.prepare('DELETE FROM qq_group_style_fts WHERE group_id = ?').run(normalizedGroupId);
      const examples = sampleEvenly(
        humanRows.filter((row) => {
          const length = normalizeText(row.text, 1_000).length;
          return length >= 4 && length <= 80;
        }),
        this.maxStyleExamples,
      );
      const referenceExamples = referenceIds.length
        ? database.prepare(`
          SELECT id, user_id, sender_name, text, author_type, created_at
          FROM qq_group_events
          WHERE group_id = ? AND author_type = 'reference_bot'
            AND user_id IN (${referencePlaceholders})
            AND length(text) BETWEEN 4 AND 60
          ORDER BY id DESC LIMIT ?
        `).all(normalizedGroupId, ...referenceIds, this.maxReferenceStyleExamples)
        : [];
      const insertExample = database.prepare(`
        INSERT INTO qq_group_style_examples(
          group_id, event_id, author_type, sender_label, text, terms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = database.prepare(`
        INSERT INTO qq_group_style_fts(group_id, example_id, terms, text) VALUES (?, ?, ?, ?)
      `);
      for (const row of [...examples, ...referenceExamples]) {
        const text = sanitizeExample(row.text, 100);
        if (!text || SAFE_EXAMPLE_PATTERN.test(text)) continue;
        if (!isUsableStyleText(text)) continue;
        if (row.author_type === 'reference_bot' && !REFERENCE_STYLE_EXAMPLE_PATTERN.test(text)) continue;
        const terms = hanBigrams(text).join(' ');
        if (!terms) continue;
        const senderLabel = row.author_type === 'reference_bot'
          ? '参考Bot'
          : normalizeLine(row.sender_name, 40) || `成员-${stableMemberId(row.user_id)}`;
        const result = insertExample.run(
          normalizedGroupId,
          Number(row.id),
          row.author_type,
          senderLabel,
          text,
          terms,
          Number(row.created_at),
        );
        insertFts.run(normalizedGroupId, Number(result.lastInsertRowid), terms, text);
      }
      database.prepare(`
        INSERT INTO qq_group_style_profiles(
          group_id, version, profile_json, source_count, source_start_at,
          source_end_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_id) DO UPDATE SET
          version = excluded.version,
          profile_json = excluded.profile_json,
          source_count = excluded.source_count,
          source_start_at = excluded.source_start_at,
          source_end_at = excluded.source_end_at,
          updated_at = excluded.updated_at
      `).run(
        normalizedGroupId,
        2,
        JSON.stringify(profile),
        sourceCount,
        Number(stats.first_at ?? 0),
        Number(stats.last_at ?? 0),
        this.now(),
      );
      database.exec('COMMIT');
    } catch (error) {
      this.rollback();
      throw error;
    }
    this.logger.log?.(`QQ 群语感卡已更新：group=${normalizedGroupId} source=${sourceCount}`);
    return true;
  }

  loadStyleProfile(groupId) {
    const row = this.ensureOpen().prepare(`
      SELECT profile_json FROM qq_group_style_profiles WHERE group_id = ?
    `).get(String(groupId ?? '').trim());
    if (!row) return null;
    try {
      return JSON.parse(String(row.profile_json));
    } catch {
      return null;
    }
  }

  saveStyleProfile(groupId, profile) {
    const normalizedGroupId = String(groupId ?? '').trim();
    if (!normalizedGroupId || !profile) return false;
    const database = this.ensureOpen();
    const updatedAt = this.now();
    const nextProfile = { ...profile, updatedAt };
    const result = database.prepare(`
      UPDATE qq_group_style_profiles
      SET version = ?, profile_json = ?, updated_at = ?
      WHERE group_id = ?
    `).run(
      Number(profile.version ?? 2),
      JSON.stringify(nextProfile),
      updatedAt,
      normalizedGroupId,
    );
    return Number(result.changes) > 0;
  }

  async generateStyleCard(groupId, profile) {
    if (!this.chatClient || !profile) return null;
    const database = this.ensureOpen();
    const rows = database.prepare(`
      SELECT sender_name, text, created_at
      FROM qq_group_events
      WHERE group_id = ? AND author_type = 'human' AND text <> '' AND text NOT LIKE '/%'
      ORDER BY id ASC
    `).all(String(groupId ?? '').trim())
      .filter((row) => needsSummary(row.text)
        && !SAFE_EXAMPLE_PATTERN.test(row.text)
        && isUsableStyleText(row.text));
    if (rows.length < MIN_STYLE_CARD_MESSAGES) return null;
    const windows = [];
    for (let index = 0; index < rows.length; index += 6) {
      const window = rows.slice(index, index + 6);
      if (window.length >= 3) windows.push(window);
    }
    const sampledWindows = sampleEvenly(windows, 24);
    if (!sampledWindows.length) return null;
    const input = [
      `群级统计：${JSON.stringify(profile.styleCard ?? {})}`,
      `高频词：${(profile.commonTerms ?? []).slice(0, 10).map((item) => item.term).join('、')}`,
      `反复短句：${(profile.repeatedPhrases ?? []).slice(0, 8).join(' / ')}`,
      '分层抽样对话窗口：',
      ...sampledWindows.map((window, index) => [
        `窗口 ${index + 1}`,
        ...window.map((row) => `${normalizeLine(row.sender_name, 24) || '群友'}：${sanitizeExample(row.text, 100)}`),
      ].join('\n')),
    ].join('\n');
    const raw = await this.chatClient.complete([], input, {
      systemPrompt: [
        '你是 QQ 群聊的本地语感观察器。只总结这群人的表达习惯，不建立任何个人人格。',
        '输出严格 JSON：{"catchphrases":[],"memeMechanisms":[],"banterMechanisms":[],"rhythmRules":[]}。',
        '每项最多 6 条、每条不超过 40 字；只描述可观察的句长、断句、接话、复读、反问、互损、笑点和固定短句。',
        '不要输出昵称、QQ 号、链接、现实身份、个人事实或可能伤害个人的评价；不要复述整句原文；不要把群梗写成现实事实。',
      ].join('\n'),
      maxTokens: 500,
      temperature: 0.1,
      usageSource: 'group-style-card',
      timeoutMs: 45_000,
      thinking: { type: 'disabled' },
    });
    const match = String(raw ?? '').trim().match(/\{[\s\S]*\}/u);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const clean = (values, limit = 6) => uniqueStrings(values, limit, 40)
      .filter((value) => !SAFE_EXAMPLE_PATTERN.test(value))
      .filter((value) => isUsableStyleText(value));
    const card = {
      catchphrases: clean(parsed.catchphrases),
      memeMechanisms: clean(parsed.memeMechanisms),
      banterMechanisms: clean(parsed.banterMechanisms),
      rhythmRules: clean(parsed.rhythmRules),
    };
    if (Object.values(card).every((values) => values.length === 0)) return null;
    return card;
  }

  async refreshStyleProfile(groupId) {
    if (!this.rebuildStyleProfile(groupId)) return false;
    const profile = this.loadStyleProfile(groupId);
    if (!profile) return false;
    try {
      const card = await this.generateStyleCard(groupId, profile);
      if (!card) return true;
      const semanticRules = uniqueStrings([
        ...(card.catchphrases ?? []).map((value) => `群内短句：${value}`),
        ...(card.memeMechanisms ?? []).map((value) => `接梗机制：${value}`),
        ...(card.banterMechanisms ?? []).map((value) => `互损方式：${value}`),
        ...(card.rhythmRules ?? []).map((value) => `节奏：${value}`),
      ], 10, 160);
      const nextProfile = {
        ...profile,
        version: 3,
        semanticCard: card,
        styleRules: uniqueStrings([...(profile.styleRules ?? []), ...semanticRules], 14, 180),
      };
      this.saveStyleProfile(groupId, nextProfile);
    } catch (error) {
      this.logger.warn?.(`QQ 群语义语感卡生成失败：group=${groupId} ${error.message}`);
    }
    return true;
  }

  styleExamples(groupId, query, { limit = 5, attack = false } = {}) {
    const database = this.ensureOpen();
    const queryTerms = hanBigrams(query).slice(0, 20);
    const ftsTerms = [...queryTerms];
    if (attack) ftsTerms.push('傻逼', '妈的', '滚', '狗', '废物', '闭嘴');
    const match = ftsTerms
      .map((term) => `"${String(term).replaceAll('"', ' ')}"`)
      .join(' OR ');
    const rows = [];
    if (match) {
      try {
        rows.push(...database.prepare(`
          SELECT e.id, e.text, e.author_type, e.sender_label
          FROM qq_group_style_fts AS f
          JOIN qq_group_style_examples AS e ON e.id = CAST(f.example_id AS INTEGER)
          WHERE qq_group_style_fts MATCH ? AND f.group_id = ?
          LIMIT 80
        `).all(match, String(groupId ?? '').trim()));
      } catch {
        // FTS tokenizer differences fall back to recent examples below.
      }
    }
    if (rows.length < limit) {
      rows.push(...database.prepare(`
        SELECT id, text, author_type, sender_label
        FROM qq_group_style_examples
        WHERE group_id = ?
        ORDER BY CASE WHEN author_type = 'reference_bot' THEN 1 ELSE 0 END, id DESC
        LIMIT ?
      `).all(String(groupId ?? '').trim(), limit * 8));
    }
    rows.push(...database.prepare(`
      SELECT id, text, author_type, sender_label
      FROM qq_group_style_examples
      WHERE group_id = ? AND author_type = 'reference_bot'
      ORDER BY id DESC LIMIT ?
    `).all(String(groupId ?? '').trim(), Math.max(limit * 4, 20)));
    const seen = new Set();
    const normalizedQuery = normalizeLine(query, 200);
    const queryTermSet = new Set(hanBigrams(normalizedQuery));
    return rows
      .filter((row) => {
        const text = sanitizeExample(row.text, 100);
        if (!text || text === normalizedQuery || seen.has(text)) return false;
        if (!isUsableStyleText(text)) return false;
        if (attack && !ATTACK_EXAMPLE_PATTERN.test(text)) return false;
        seen.add(text);
        return true;
      })
      .map((row) => ({
        row,
        overlap: hanBigrams(row.text).filter((term) => queryTermSet.has(term)).length,
      }))
      .sort((left, right) => (
        right.overlap - left.overlap
        || Number(left.row.author_type === 'reference_bot')
          - Number(right.row.author_type === 'reference_bot')
        || Number(right.row.id ?? 0) - Number(left.row.id ?? 0)
      ))
      .map((entry) => entry.row)
      .slice(0, Math.max(1, limit));
  }

  buildStylePrompt({ groupId, query = '', attack = false } = {}) {
    const normalizedGroupId = String(groupId ?? '').trim();
    if (!this.isStyleEnabled(normalizedGroupId)) return '';
    const profile = this.loadStyleProfile(normalizedGroupId);
    if (!profile || Number(profile.sourceCount ?? 0) < MIN_STYLE_SOURCE_MESSAGES) return '';
    const limit = attack ? 2 : 5;
    const examples = this.styleExamples(normalizedGroupId, query, { limit, attack });
    const allStyleRules = uniqueStrings(profile.styleRules, 20, 180);
    const semanticRulePattern = /^(?:群内短句|接梗机制|互损方式|节奏：)/u;
    const voiceRulePattern = /(?:群内短句|接梗机制|互损方式|节奏：|复读|互损|拆台|接梗|接话|吐槽|反问)/u;
    const metricRulePattern = /(?:中位长度|不超过\s*\d+\s*字|带问号|标点|emoji)/iu;
    const prioritizedRules = uniqueStrings([
      ...allStyleRules.filter((rule) => semanticRulePattern.test(rule)),
      ...allStyleRules.filter((rule) => !semanticRulePattern.test(rule) && voiceRulePattern.test(rule)),
      ...allStyleRules.filter((rule) => !voiceRulePattern.test(rule) && !metricRulePattern.test(rule)),
      ...allStyleRules.filter((rule) => metricRulePattern.test(rule)),
    ], 6, 180);
    const repeated = uniqueStrings(profile.repeatedPhrases, 8, 24);
    const common = uniqueStrings((profile.commonTerms ?? []).map((item) => item.term), 10, 24);
    const lines = [
      '【本群真实语感参考】',
      '先学他们怎么接话：短促表态、顺梗、反问、拆台、说到一半就停；不是给普通答案套语气词。',
      '逻辑是骨架，玩梗是表达：涉及事实、判断或解决办法时，先把具体结论和依据说清楚，再用贴题的反问、比喻、吐槽或群梗包住；不要把玩梗和回答二选一。',
      '不要照抄样本，也不要用“你说得对”“你提醒得对”“我上一轮理解错了”等认错或客服式元话术固定开场；需要纠正时直接给出修正后的事实和回答。',
      ...prioritizedRules,
      common.length ? `群内常见词和语气：${common.join('、')}` : '',
      repeated.length ? `反复出现的群内短句/梗：${repeated.join(' / ')}` : '',
      '这些是表达习惯和群内玩笑机制，不是现实事实，也不要在无关话题里硬塞。',
    ];
    if (examples.length) {
      lines.push(attack
        ? '真实发言节奏参考（只借句长、断句、力度和接话方式；不要照抄骂法、对象或原句）：'
        : '真实发言节奏参考（只借句长、断句、态度强弱和接话动作；不要复述原句、人名、事件或事实）：');
      lines.push(...examples.map((row, index) => (
        `${index + 1}. ${row.author_type === 'reference_bot' ? '参考Bot：' : ''}${sanitizeExample(row.text, 100)}`
      )));
    }
    lines.push('先像群里正在接话的人一样接住当前这句，再决定要不要补信息；示例不贴题就忽略，不为了使用示例而偏题。');
    return lines.filter(Boolean).join('\n');
  }

  async refreshStyles() {
    let updated = 0;
    for (const groupId of this.styleGroups) {
      try {
        if (await this.refreshStyleProfile(groupId)) updated += 1;
      } catch (error) {
        this.logger.warn?.(`QQ 群语感卡刷新失败：group=${groupId} ${error.message}`);
      }
    }
    return updated;
  }

  startStyleRefresh() {
    if (this.styleRefreshTimer || this.styleGroups.size === 0) return;
    // 启动后先用当前历史重建一次，不等第一个 6 小时周期。
    void this.refreshStyles();
    this.styleRefreshTimer = setInterval(() => {
      void this.refreshStyles();
    }, this.styleRefreshHours * HOUR_MS);
    this.styleRefreshTimer.unref?.();
  }

  async backfillFromQqMemoryDatabase(qqMemoryDatabasePath, options = {}) {
    const source = new DatabaseSync(String(qqMemoryDatabasePath), { readOnly: true });
    source.exec('PRAGMA query_only=ON');
    try {
      const rows = source.prepare(`
        SELECT id, conversation_id, role, content, created_at
        FROM qq_messages
        WHERE conversation_id LIKE 'group:%'
        ORDER BY id ASC
      `).all();
      const memberRows = source.prepare(`
        SELECT group_id, user_id, speaker_id FROM qq_group_members
      `).all();
      let observationRows = [];
      try {
        observationRows = source.prepare(`
          SELECT id, group_id, user_id, content, created_at
          FROM qq_group_member_observations
          ORDER BY id ASC
        `).all();
      } catch {
        // Older QQ memory databases predate member observations.
      }
      const userIdByGroupSpeaker = new Map(memberRows.map((row) => (
        [`${row.group_id}:${row.speaker_id}`, String(row.user_id)]
      )));
      const recentCutoff = Number(
        options.recentTopicCutoff
        ?? (this.now() - this.topicKeepClosedMs - HOUR_MS),
      );
      const groupFilter = new Set((options.groups ?? [...this.enabledGroups])
        .map((groupId) => String(groupId ?? '').trim())
        .filter(Boolean));
      const database = this.ensureOpen();
      let inserted = 0;
      let topics = 0;
      const qqMessageHumanTimes = new Map();
      const humanMessageKey = (groupId, userId, text) => (
        `${groupId}|${userId}|${normalizeText(text, 4_000)}`
      );
      const rememberQqMessage = (groupId, userId, text, createdAt) => {
        const key = humanMessageKey(groupId, userId, text);
        const times = qqMessageHumanTimes.get(key) ?? [];
        times.push(Number(createdAt));
        qqMessageHumanTimes.set(key, times);
      };
      const duplicateOfQqMessage = (groupId, userId, text, createdAt) => {
        const times = qqMessageHumanTimes.get(humanMessageKey(groupId, userId, text)) ?? [];
        return times.some((timestamp) => Math.abs(Number(timestamp) - Number(createdAt)) <= 5 * MINUTE_MS);
      };
      database.exec('BEGIN IMMEDIATE');
      try {
        const insert = database.prepare(`
          INSERT OR IGNORE INTO qq_group_events(
            group_id, conversation_id, user_id, sender_name, message_id,
            quoted_message_id, quoted_user_id, quoted_text, text, kind,
            author_type, created_at, inserted_at
          ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 'text', ?, ?, ?)
        `);
        for (const row of rows) {
          const groupId = String(row.conversation_id).slice('group:'.length);
          if (groupFilter.size > 0 && !groupFilter.has(groupId)) continue;
          const createdAt = Number(row.created_at ?? 0);
          if (row.role === 'assistant') {
            const sourceText = String(row.content ?? '');
            const markerIndex = sourceText.indexOf('\n机器人回复：');
            const text = markerIndex >= 0
              ? sourceText.slice(markerIndex + '\n机器人回复：'.length).trim()
              : sourceText.trim();
            if (!text) continue;
            const result = insert.run(
              groupId,
              String(row.conversation_id),
              'bot',
              '机器人',
              `legacy:${row.id}`,
              '',
              '',
              text,
              'own_bot',
              createdAt,
              this.now(),
            );
            inserted += Number(result.changes);
            continue;
          }
          const parsed = parseStoredUserObservation(row.content);
          if (!parsed) continue;
          const userId = userIdByGroupSpeaker.get(`${groupId}:${parsed.memberId}`)
            || (parsed.memberId ? `member:${parsed.memberId}` : `speaker:${parsed.speakerName}`);
          const quotedUserId = userIdByGroupSpeaker.get(`${groupId}:${parsed.quotedMemberId}`) || '';
          const authorType = this.referenceBotIds(groupId).has(userId) ? 'reference_bot' : 'human';
          // The QQ memory DB keeps every observed human message here, while
          // qq_messages only keeps turns that received a reply. Most groups
          // have far more raw observations, so they are the better style source.
          // Skip only the same message already imported from qq_messages.
          if (authorType === 'human') rememberQqMessage(groupId, userId, parsed.text, createdAt);
          const result = insert.run(
            groupId,
            String(row.conversation_id),
            userId,
            parsed.speakerName,
            `legacy:${row.id}`,
            quotedUserId,
            parsed.quoteText,
            parsed.text,
            authorType,
            createdAt,
            this.now(),
          );
          inserted += Number(result.changes);
        }
        if (observationRows.length > 0) {
          const insertObservation = database.prepare(`
            INSERT OR IGNORE INTO qq_group_events(
              group_id, conversation_id, user_id, sender_name, message_id,
              quoted_message_id, quoted_user_id, quoted_text, text, kind,
              author_type, created_at, inserted_at
            ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 'text', ?, ?, ?)
          `);
          for (const row of observationRows) {
            const groupId = String(row.group_id ?? '').trim();
            if (!groupId || (groupFilter.size > 0 && !groupFilter.has(groupId))) continue;
            const parsed = parseStoredUserObservation(row.content);
            if (!parsed) continue;
            const userId = String(row.user_id ?? '').trim()
              || (parsed.memberId ? `member:${parsed.memberId}` : `speaker:${parsed.speakerName}`);
            const createdAt = Number(row.created_at ?? 0);
            const authorType = this.referenceBotIds(groupId).has(userId) ? 'reference_bot' : 'human';
            if (authorType === 'human'
              && duplicateOfQqMessage(groupId, userId, parsed.text, createdAt)) {
              continue;
            }
            const quotedUserId = userIdByGroupSpeaker.get(`${groupId}:${parsed.quotedMemberId}`) || '';
            const result = insertObservation.run(
              groupId,
              `group:${groupId}`,
              userId,
              parsed.speakerName,
              `legacy-observation:${row.id}`,
              quotedUserId,
              parsed.quoteText,
              parsed.text,
              authorType,
              createdAt,
              this.now(),
            );
            inserted += Number(result.changes);
          }
        }
        database.exec('COMMIT');
      } catch (error) {
        this.rollback();
        throw error;
      }
      if (options.rebuildTopics !== false) {
        for (const groupId of groupFilter) {
          database.exec('BEGIN IMMEDIATE');
          try {
            database.prepare('DELETE FROM qq_group_topic_fts WHERE group_id = ?').run(groupId);
            database.prepare('DELETE FROM qq_group_topics WHERE group_id = ?').run(groupId);
            database.prepare(`
              UPDATE qq_group_events SET topic_id = NULL, topic_confidence = 0
              WHERE group_id = ?
            `).run(groupId);
            const recent = database.prepare(`
              SELECT id FROM qq_group_events
              WHERE group_id = ? AND created_at >= ? AND author_type <> 'own_bot'
              ORDER BY id ASC
            `).all(groupId, recentCutoff);
            for (const row of recent) {
              const assignment = this.assignTopic(Number(row.id), {});
              if (assignment.topicId) topics += 1;
            }
            database.exec('COMMIT');
          } catch (error) {
            this.rollback();
            throw error;
          }
        }
      }
      return { inserted, topics };
    } finally {
      source.close();
    }
  }

  getStats() {
    const database = this.ensureOpen();
    return {
      groupEvents: Number(database.prepare('SELECT COUNT(*) AS count FROM qq_group_events').get().count),
      groupTopics: Number(database.prepare('SELECT COUNT(*) AS count FROM qq_group_topics').get().count),
      groupStyleProfiles: Number(database.prepare('SELECT COUNT(*) AS count FROM qq_group_style_profiles').get().count),
    };
  }

  async flush() {
    await Promise.allSettled([...this.pendingSummaries.values()]);
  }

  close() {
    for (const timer of this.summaryTimers.values()) clearTimeout(timer);
    this.summaryTimers.clear();
    if (this.styleRefreshTimer) clearInterval(this.styleRefreshTimer);
    this.styleRefreshTimer = null;
    this.database?.close();
    this.database = null;
  }
}

export const GROUP_TOPIC_CONSTANTS = {
  TOPIC_MATCH_THRESHOLD,
  TOPIC_ASSIGN_THRESHOLD,
  TOPIC_AMBIGUITY_MARGIN,
  MIN_STYLE_SOURCE_MESSAGES,
};
