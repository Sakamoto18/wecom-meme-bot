import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_MESSAGES = 80;
const DEFAULT_MAX_CHARACTERS = 30_000;
const DEFAULT_MAX_CONVERSATIONS = 300;
const DEFAULT_MAX_STORED_MESSAGES = 2_000;
const DEFAULT_SUMMARY_TRIGGER_MESSAGES = 40;
const DEFAULT_SUMMARY_KEEP_MESSAGES = 20;
const DEFAULT_MAX_SUMMARY_CHARACTERS = 3_000;
const DEFAULT_SUMMARY_INPUT_CHARACTERS = 30_000;
const LEGACY_MIGRATION_KEY = 'legacy_json_migrated_v1';

function cloneMessages(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: String(message.content ?? ''),
  }));
}

function shortenContent(content, limit) {
  const normalized = String(content ?? '');
  if (normalized.length <= limit) return normalized;
  const headLength = Math.max(1, Math.floor((limit - 1) / 2));
  const tailLength = Math.max(1, limit - headLength - 1);
  return normalized.slice(0, headLength) + '…' + normalized.slice(-tailLength);
}

function fitMessages(messages, maxMessages, maxCharacters) {
  let fitted = cloneMessages(messages).slice(-maxMessages);
  const countCharacters = () => fitted.reduce(
    (total, message) => total + message.content.length,
    0,
  );

  while (fitted.length > 1 && countCharacters() > maxCharacters) {
    fitted = fitted.slice(1);
  }

  if (countCharacters() > maxCharacters && fitted.length > 0) {
    const perMessageLimit = Math.max(80, Math.floor(maxCharacters / fitted.length));
    fitted = fitted.map((message) => ({
      ...message,
      content: shortenContent(message.content, perMessageLimit),
    }));
  }
  return fitted;
}

function normalizedPositiveInteger(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function stableParticipantId(userId) {
  return createHash('sha256')
    .update(String(userId ?? 'anonymous'))
    .digest('hex')
    .slice(0, 6);
}

function safeNames(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean).slice(-8) : [];
  } catch {
    return [];
  }
}

export class QqMemoryStore {
  constructor(options = {}) {
    this.databaseFilePath = options.databaseFilePath?.trim() || '';
    this.legacyFilePath = options.legacyFilePath?.trim() || '';
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
    this.maxConversations = options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS;
    this.maxStoredMessages = options.maxStoredMessages ?? DEFAULT_MAX_STORED_MESSAGES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.summaryTriggerMessages = normalizedPositiveInteger(
      options.summaryTriggerMessages,
      DEFAULT_SUMMARY_TRIGGER_MESSAGES,
      2,
    );
    this.summaryKeepMessages = Math.min(
      normalizedPositiveInteger(
        options.summaryKeepMessages,
        DEFAULT_SUMMARY_KEEP_MESSAGES,
        1,
      ),
      this.summaryTriggerMessages - 1,
    );
    this.maxSummaryCharacters = options.maxSummaryCharacters
      ?? DEFAULT_MAX_SUMMARY_CHARACTERS;
    this.summaryInputCharacters = options.summaryInputCharacters
      ?? DEFAULT_SUMMARY_INPUT_CHARACTERS;
    this.now = options.now ?? Date.now;
    this.onPersistError = options.onPersistError ?? (() => {});
    this.database = null;
    this.queues = new Map();
    this.pendingSummaries = new Map();
  }

  ensureOpen() {
    if (this.database) return this.database;
    if (!this.databaseFilePath) {
      throw new Error('QQ 记忆数据库路径不能为空');
    }

    mkdirSync(path.dirname(this.databaseFilePath), { recursive: true });
    this.database = new DatabaseSync(this.databaseFilePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS qq_memory_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS qq_conversations (
        id TEXT PRIMARY KEY,
        summary TEXT NOT NULL DEFAULT '',
        summary_through_id INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS qq_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES qq_conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS qq_group_members (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        speaker_id TEXT NOT NULL,
        current_name TEXT NOT NULL DEFAULT '',
        known_names TEXT NOT NULL DEFAULT '[]',
        message_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY(group_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS qq_messages_conversation_id_id
        ON qq_messages(conversation_id, id);
      CREATE INDEX IF NOT EXISTS qq_conversations_expires_at
        ON qq_conversations(expires_at);
      CREATE INDEX IF NOT EXISTS qq_conversations_updated_at
        ON qq_conversations(updated_at);
      CREATE INDEX IF NOT EXISTS qq_group_members_group_activity
        ON qq_group_members(group_id, last_seen_at DESC);
    `);
    return this.database;
  }

  async load() {
    this.ensureOpen();
    await this.migrateLegacyFile();
    this.pruneExpired();
    this.enforceConversationLimit();
    return this.size;
  }

  async migrateLegacyFile() {
    const database = this.ensureOpen();
    const migrated = database.prepare(
      'SELECT value FROM qq_memory_metadata WHERE key = ?',
    ).get(LEGACY_MIGRATION_KEY);
    if (migrated) return 0;

    let body = null;
    if (this.legacyFilePath) {
      try {
        body = JSON.parse(await readFile(this.legacyFilePath, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw new Error('迁移旧 QQ 会话记忆失败：' + error.message);
        }
      }
    }

    const currentTime = this.now();
    let imported = 0;
    database.exec('BEGIN IMMEDIATE');
    try {
      if (body?.conversations && typeof body.conversations === 'object') {
        const upsertConversation = database.prepare(`
          INSERT INTO qq_conversations(
            id, summary, summary_through_id, created_at, updated_at, expires_at
          ) VALUES (?, '', 0, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            updated_at = MAX(updated_at, excluded.updated_at),
            expires_at = MAX(expires_at, excluded.expires_at)
        `);
        const insertMessage = database.prepare(`
          INSERT INTO qq_messages(conversation_id, role, content, created_at)
          VALUES (?, ?, ?, ?)
        `);

        for (const [conversationId, entry] of Object.entries(body.conversations)) {
          if (!Array.isArray(entry?.messages)
            || !Number.isFinite(entry.expiresAt)
            || entry.expiresAt <= currentTime) {
            continue;
          }
          const messages = entry.messages.filter((message) => (
            (message?.role === 'user' || message?.role === 'assistant')
            && typeof message.content === 'string'
          ));
          if (messages.length === 0) continue;

          const updatedAt = Number.isFinite(entry.updatedAt)
            ? entry.updatedAt
            : currentTime;
          upsertConversation.run(
            conversationId,
            updatedAt,
            updatedAt,
            entry.expiresAt,
          );
          messages.forEach((message, index) => {
            insertMessage.run(
              conversationId,
              message.role,
              message.content,
              updatedAt - messages.length + index,
            );
          });
          imported += 1;
        }
      }

      database.prepare(`
        INSERT INTO qq_memory_metadata(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(LEGACY_MIGRATION_KEY, String(currentTime));
      database.exec('COMMIT');
      return imported;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  pruneExpired() {
    this.ensureOpen().prepare(
      'DELETE FROM qq_conversations WHERE expires_at <= ?',
    ).run(this.now());
  }

  enforceConversationLimit() {
    const database = this.ensureOpen();
    const count = Number(database.prepare(
      'SELECT COUNT(*) AS count FROM qq_conversations',
    ).get().count);
    const overflow = count - this.maxConversations;
    if (overflow <= 0) return;
    database.prepare(`
      DELETE FROM qq_conversations
      WHERE id IN (
        SELECT id FROM qq_conversations
        ORDER BY updated_at ASC
        LIMIT ?
      )
    `).run(overflow);
  }

  get size() {
    this.pruneExpired();
    return Number(this.ensureOpen().prepare(
      'SELECT COUNT(*) AS count FROM qq_conversations',
    ).get().count);
  }

  get(conversationId) {
    const database = this.ensureOpen();
    const conversation = database.prepare(`
      SELECT summary_through_id
      FROM qq_conversations
      WHERE id = ? AND expires_at > ?
    `).get(conversationId, this.now());
    if (!conversation) {
      database.prepare(
        'DELETE FROM qq_conversations WHERE id = ? AND expires_at <= ?',
      ).run(conversationId, this.now());
      return [];
    }

    const messages = database.prepare(`
      SELECT role, content
      FROM qq_messages
      WHERE conversation_id = ? AND id > ?
      ORDER BY id DESC
      LIMIT ?
    `).all(
      conversationId,
      Number(conversation.summary_through_id),
      this.maxMessages,
    ).reverse();
    return fitMessages(messages, this.maxMessages, this.maxCharacters);
  }

  getSummary(conversationId) {
    const database = this.ensureOpen();
    const row = database.prepare(`
      SELECT summary
      FROM qq_conversations
      WHERE id = ? AND expires_at > ?
    `).get(conversationId, this.now());
    if (!row) {
      database.prepare(
        'DELETE FROM qq_conversations WHERE id = ? AND expires_at <= ?',
      ).run(conversationId, this.now());
    }
    return String(row?.summary ?? '').trim();
  }

  appendMessages(conversationId, messages) {
    const database = this.ensureOpen();
    const currentTime = this.now();
    const normalizedMessages = messages
      .filter((message) => message?.role === 'user' || message?.role === 'assistant')
      .map((message) => ({
        role: message.role,
        content: String(message.content ?? '').trim(),
      }))
      .filter((message) => message.content);
    if (normalizedMessages.length === 0) return false;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(
        'DELETE FROM qq_conversations WHERE id = ? AND expires_at <= ?',
      ).run(conversationId, currentTime);
      database.prepare(`
        INSERT INTO qq_conversations(
          id, summary, summary_through_id, created_at, updated_at, expires_at
        ) VALUES (?, '', 0, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
      `).run(
        conversationId,
        currentTime,
        currentTime,
        currentTime + this.ttlMs,
      );
      const insertMessage = database.prepare(`
        INSERT INTO qq_messages(conversation_id, role, content, created_at)
        VALUES (?, ?, ?, ?)
      `);
      normalizedMessages.forEach((message, index) => {
        insertMessage.run(
          conversationId,
          message.role,
          message.content,
          currentTime + index,
        );
      });
      database.prepare(`
        DELETE FROM qq_messages
        WHERE conversation_id = ?
          AND id NOT IN (
            SELECT id FROM qq_messages
            WHERE conversation_id = ?
            ORDER BY id DESC
            LIMIT ?
          )
      `).run(conversationId, conversationId, this.maxStoredMessages);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    this.enforceConversationLimit();
    return true;
  }

  appendMessage(conversationId, role, content) {
    return this.appendMessages(conversationId, [{ role, content }]);
  }

  appendObservation(conversationId, content) {
    return this.appendMessage(conversationId, 'user', content);
  }

  appendExchange(conversationId, userContent, assistantContent) {
    return this.appendMessages(conversationId, [
      { role: 'user', content: userContent },
      { role: 'assistant', content: assistantContent },
    ]);
  }

  recordGroupMember(groupId, userId, displayName = '', options = {}) {
    const normalizedGroupId = String(groupId ?? '').trim();
    const normalizedUserId = String(userId ?? '').trim();
    if (!normalizedGroupId || !normalizedUserId) return false;
    const database = this.ensureOpen();
    const currentTime = this.now();
    const normalizedName = String(displayName ?? '')
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 80);
    const existing = database.prepare(`
      SELECT current_name, known_names
      FROM qq_group_members
      WHERE group_id = ? AND user_id = ?
    `).get(normalizedGroupId, normalizedUserId);
    const names = safeNames(existing?.known_names);
    if (normalizedName && !names.includes(normalizedName)) names.push(normalizedName);
    database.prepare(`
      INSERT INTO qq_group_members(
        group_id, user_id, speaker_id, current_name, known_names,
        message_count, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_id, user_id) DO UPDATE SET
        current_name = CASE
          WHEN excluded.current_name <> '' THEN excluded.current_name
          ELSE qq_group_members.current_name
        END,
        known_names = excluded.known_names,
        message_count = qq_group_members.message_count + excluded.message_count,
        last_seen_at = excluded.last_seen_at
    `).run(
      normalizedGroupId,
      normalizedUserId,
      stableParticipantId(normalizedUserId),
      normalizedName,
      JSON.stringify(names.slice(-8)),
      options.countMessage === false ? 0 : 1,
      currentTime,
      currentTime,
    );
    return true;
  }

  getGroupMemberAliases(groupId, limit = 40) {
    const rows = this.ensureOpen().prepare(`
      SELECT speaker_id, current_name
      FROM qq_group_members
      WHERE group_id = ? AND current_name <> ''
      ORDER BY last_seen_at DESC
      LIMIT ?
    `).all(String(groupId ?? '').trim(), limit);
    return Object.fromEntries(rows.map((row) => [row.speaker_id, row.current_name]));
  }

  getGroupMembers(groupId, limit = 40) {
    return this.ensureOpen().prepare(`
      SELECT speaker_id, current_name, known_names, message_count,
             first_seen_at, last_seen_at
      FROM qq_group_members
      WHERE group_id = ?
      ORDER BY last_seen_at DESC
      LIMIT ?
    `).all(String(groupId ?? '').trim(), limit).map((row) => ({
      speakerId: row.speaker_id,
      currentName: row.current_name,
      knownNames: safeNames(row.known_names),
      messageCount: Number(row.message_count),
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at),
    }));
  }

  clear(conversationId) {
    const result = this.ensureOpen().prepare(
      'DELETE FROM qq_conversations WHERE id = ?',
    ).run(conversationId);
    return Number(result.changes) > 0;
  }

  getSummarySnapshot(conversationId) {
    const database = this.ensureOpen();
    const conversation = database.prepare(`
      SELECT summary, summary_through_id
      FROM qq_conversations
      WHERE id = ? AND expires_at > ?
    `).get(conversationId, this.now());
    if (!conversation) return null;

    const unsummarizedCount = Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM qq_messages
      WHERE conversation_id = ? AND id > ?
    `).get(conversationId, Number(conversation.summary_through_id)).count);
    if (unsummarizedCount < this.summaryTriggerMessages) return null;

    let summarizeCount = Math.min(
      unsummarizedCount - this.summaryKeepMessages,
      this.summaryTriggerMessages - this.summaryKeepMessages,
    );
    if (summarizeCount < 1) return null;
    const rows = database.prepare(`
      SELECT id, role, content
      FROM qq_messages
      WHERE conversation_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(
      conversationId,
      Number(conversation.summary_through_id),
      summarizeCount,
    );
    const perMessageLimit = Math.max(
      200,
      Math.floor(this.summaryInputCharacters / rows.length),
    );
    return {
      conversationId,
      previousSummary: String(conversation.summary ?? '').trim(),
      previousSummaryThroughId: Number(conversation.summary_through_id),
      summaryThroughId: Number(rows.at(-1)?.id ?? 0),
      messages: rows.map((message) => ({
        role: message.role,
        content: shortenContent(message.content, perMessageLimit),
      })),
    };
  }

  scheduleSummary(conversationId, summarizer) {
    if (typeof summarizer !== 'function') return Promise.resolve(false);
    const existing = this.pendingSummaries.get(conversationId);
    if (existing) return existing;
    const snapshot = this.getSummarySnapshot(conversationId);
    if (!snapshot) return Promise.resolve(false);

    const task = Promise.resolve()
      .then(() => summarizer(snapshot))
      .then((summary) => {
        const normalized = String(summary ?? '').trim();
        if (!normalized) return false;
        const result = this.ensureOpen().prepare(`
          UPDATE qq_conversations
          SET summary = ?, summary_through_id = ?
          WHERE id = ? AND summary_through_id = ? AND expires_at > ?
        `).run(
          shortenContent(normalized, this.maxSummaryCharacters),
          snapshot.summaryThroughId,
          conversationId,
          snapshot.previousSummaryThroughId,
          this.now(),
        );
        return Number(result.changes) > 0;
      })
      .catch((error) => {
        this.onPersistError(new Error('生成 QQ 滚动记忆摘要失败：' + error.message));
        return false;
      })
      .finally(() => {
        if (this.pendingSummaries.get(conversationId) === task) {
          this.pendingSummaries.delete(conversationId);
        }
      });
    this.pendingSummaries.set(conversationId, task);
    return task;
  }

  getStats() {
    this.pruneExpired();
    const database = this.ensureOpen();
    return {
      conversations: Number(database.prepare(
        'SELECT COUNT(*) AS count FROM qq_conversations',
      ).get().count),
      messages: Number(database.prepare(
        'SELECT COUNT(*) AS count FROM qq_messages',
      ).get().count),
      summaries: Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM qq_conversations
        WHERE summary <> ''
      `).get().count),
      groupMembers: Number(database.prepare(`
        SELECT COUNT(*) AS count FROM qq_group_members
      `).get().count),
    };
  }

  async flush() {
    await Promise.allSettled([...this.pendingSummaries.values()]);
  }

  close() {
    this.database?.close();
    this.database = null;
  }

  async runExclusive(conversationId, task) {
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.queues.set(conversationId, current);

    try {
      return await current;
    } finally {
      if (this.queues.get(conversationId) === current) {
        this.queues.delete(conversationId);
      }
    }
  }
}
