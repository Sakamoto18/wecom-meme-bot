import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_MESSAGES = 80;
const DEFAULT_MAX_CHARACTERS = 30_000;
const DEFAULT_MAX_CONVERSATIONS = 300;
const DEFAULT_MAX_STORED_MESSAGES = 50_000;
const DEFAULT_MAX_TOTAL_STORED_MESSAGES = 500_000;
const DEFAULT_MIN_STORED_MESSAGES_PER_CONVERSATION = 1_000;
const DEFAULT_RAW_MESSAGE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SUMMARY_TRIGGER_MESSAGES = 40;
const DEFAULT_SUMMARY_KEEP_MESSAGES = 20;
const DEFAULT_MAX_SUMMARY_CHARACTERS = 3_000;
const DEFAULT_SUMMARY_INPUT_CHARACTERS = 30_000;
const DEFAULT_MEMBER_SUMMARY_TRIGGER_MESSAGES = 12;
const DEFAULT_MEMBER_SUMMARY_KEEP_MESSAGES = 4;
const DEFAULT_MAX_MEMBER_MEMORY_CHARACTERS = 1_500;
const DEFAULT_MAX_MEMBER_OBSERVATIONS = 120;
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
    this.maxTotalStoredMessages = options.maxTotalStoredMessages
      ?? DEFAULT_MAX_TOTAL_STORED_MESSAGES;
    this.minStoredMessagesPerConversation = Math.min(
      options.minStoredMessagesPerConversation
        ?? DEFAULT_MIN_STORED_MESSAGES_PER_CONVERSATION,
      this.maxStoredMessages,
    );
    this.rawMessageRetentionMs = options.rawMessageRetentionMs
      ?? DEFAULT_RAW_MESSAGE_RETENTION_MS;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs
      ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
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
    this.memberSummaryTriggerMessages = normalizedPositiveInteger(
      options.memberSummaryTriggerMessages,
      DEFAULT_MEMBER_SUMMARY_TRIGGER_MESSAGES,
      2,
    );
    this.memberSummaryKeepMessages = Math.min(
      normalizedPositiveInteger(
        options.memberSummaryKeepMessages,
        DEFAULT_MEMBER_SUMMARY_KEEP_MESSAGES,
        1,
      ),
      this.memberSummaryTriggerMessages - 1,
    );
    this.maxMemberMemoryCharacters = options.maxMemberMemoryCharacters
      ?? DEFAULT_MAX_MEMBER_MEMORY_CHARACTERS;
    this.maxMemberObservations = options.maxMemberObservations
      ?? DEFAULT_MAX_MEMBER_OBSERVATIONS;
    this.now = options.now ?? Date.now;
    this.onPersistError = options.onPersistError ?? (() => {});
    this.database = null;
    this.queues = new Map();
    this.pendingSummaries = new Map();
    this.pendingMemberSummaries = new Map();
    this.lastMaintenanceAt = 0;
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
        confirmed_names TEXT NOT NULL DEFAULT '[]',
        identity_confirmed INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY(group_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS qq_group_member_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS qq_messages_conversation_id_id
        ON qq_messages(conversation_id, id);
      CREATE INDEX IF NOT EXISTS qq_conversations_expires_at
        ON qq_conversations(expires_at);
      CREATE INDEX IF NOT EXISTS qq_conversations_updated_at
        ON qq_conversations(updated_at);
      CREATE INDEX IF NOT EXISTS qq_group_members_group_activity
        ON qq_group_members(group_id, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS qq_group_member_observations_member_id
        ON qq_group_member_observations(group_id, user_id, id);
    `);
    const memberColumns = new Set(
      this.database.prepare('PRAGMA table_info(qq_group_members)').all()
        .map((column) => column.name),
    );
    if (!memberColumns.has('confirmed_names')) {
      this.database.exec("ALTER TABLE qq_group_members ADD COLUMN confirmed_names TEXT NOT NULL DEFAULT '[]'");
    }
    if (!memberColumns.has('identity_confirmed')) {
      this.database.exec('ALTER TABLE qq_group_members ADD COLUMN identity_confirmed INTEGER NOT NULL DEFAULT 0');
      this.database.exec(`
        UPDATE qq_group_members
        SET identity_confirmed = 1,
            confirmed_names = known_names
        WHERE message_count > 0
      `);
    }
    if (!memberColumns.has('memory')) {
      this.database.exec("ALTER TABLE qq_group_members ADD COLUMN memory TEXT NOT NULL DEFAULT ''");
    }
    if (!memberColumns.has('memory_through_observation_id')) {
      this.database.exec('ALTER TABLE qq_group_members ADD COLUMN memory_through_observation_id INTEGER NOT NULL DEFAULT 0');
    }
    if (!memberColumns.has('memory_updated_at')) {
      this.database.exec('ALTER TABLE qq_group_members ADD COLUMN memory_updated_at INTEGER NOT NULL DEFAULT 0');
    }
    return this.database;
  }

  async load() {
    this.ensureOpen();
    await this.migrateLegacyFile();
    this.performMaintenance({ force: true });
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

  pruneAgedSummarizedMessages() {
    if (!Number.isFinite(this.rawMessageRetentionMs)
      || this.rawMessageRetentionMs <= 0) return 0;
    const database = this.ensureOpen();
    const cutoff = this.now() - this.rawMessageRetentionMs;
    const conversations = database.prepare(`
      SELECT id, summary_through_id
      FROM qq_conversations
      WHERE summary_through_id > 0
    `).all();
    let removed = 0;
    database.exec('BEGIN IMMEDIATE');
    try {
      const pruneConversation = database.prepare(`
        DELETE FROM qq_messages
        WHERE conversation_id = ?
          AND id <= ?
          AND created_at < ?
          AND id NOT IN (
            SELECT id FROM qq_messages
            WHERE conversation_id = ?
            ORDER BY id DESC
            LIMIT ?
          )
      `);
      for (const conversation of conversations) {
        const result = pruneConversation.run(
          conversation.id,
          Number(conversation.summary_through_id),
          cutoff,
          conversation.id,
          this.minStoredMessagesPerConversation,
        );
        removed += Number(result.changes);
      }
      database.exec('COMMIT');
      return removed;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  enforceGlobalMessageLimit() {
    const database = this.ensureOpen();
    const count = Number(database.prepare(
      'SELECT COUNT(*) AS count FROM qq_messages',
    ).get().count);
    const overflow = count - this.maxTotalStoredMessages;
    if (overflow <= 0) return 0;
    const result = database.prepare(`
      DELETE FROM qq_messages
      WHERE id IN (
        SELECT message.id
        FROM qq_messages AS message
        JOIN qq_conversations AS conversation
          ON conversation.id = message.conversation_id
        WHERE message.id <= conversation.summary_through_id
          AND message.id NOT IN (
            SELECT retained.id
            FROM qq_messages AS retained
            WHERE retained.conversation_id = message.conversation_id
            ORDER BY retained.id DESC
            LIMIT ?
          )
        ORDER BY message.created_at ASC, message.id ASC
        LIMIT ?
      )
    `).run(this.minStoredMessagesPerConversation, overflow);
    return Number(result.changes);
  }

  performMaintenance(options = {}) {
    const currentTime = this.now();
    if (!options.force
      && currentTime - this.lastMaintenanceAt < this.maintenanceIntervalMs) {
      return { ran: false, agedMessagesRemoved: 0, overflowMessagesRemoved: 0 };
    }
    this.pruneExpired();
    this.enforceConversationLimit();
    const agedMessagesRemoved = this.pruneAgedSummarizedMessages();
    const overflowMessagesRemoved = this.enforceGlobalMessageLimit();
    this.ensureOpen().exec('PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE);');
    this.lastMaintenanceAt = currentTime;
    return { ran: true, agedMessagesRemoved, overflowMessagesRemoved };
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
    this.performMaintenance();
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
      SELECT current_name, known_names, confirmed_names, identity_confirmed
      FROM qq_group_members
      WHERE group_id = ? AND user_id = ?
    `).get(normalizedGroupId, normalizedUserId);
    const names = safeNames(existing?.known_names);
    if (normalizedName && !names.includes(normalizedName)) names.push(normalizedName);
    const confirmIdentity = options.confirmIdentity === true
      || (options.confirmIdentity !== false && options.countMessage !== false);
    const confirmedNames = safeNames(existing?.confirmed_names);
    if (confirmIdentity && normalizedName && !confirmedNames.includes(normalizedName)) {
      confirmedNames.push(normalizedName);
    }
    database.prepare(`
      INSERT INTO qq_group_members(
        group_id, user_id, speaker_id, current_name, known_names,
        confirmed_names, identity_confirmed, message_count,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_id, user_id) DO UPDATE SET
        current_name = CASE
          WHEN excluded.current_name <> '' THEN excluded.current_name
          ELSE qq_group_members.current_name
        END,
        known_names = excluded.known_names,
        confirmed_names = excluded.confirmed_names,
        identity_confirmed = MAX(
          qq_group_members.identity_confirmed,
          excluded.identity_confirmed
        ),
        message_count = qq_group_members.message_count + excluded.message_count,
        last_seen_at = excluded.last_seen_at
    `).run(
      normalizedGroupId,
      normalizedUserId,
      stableParticipantId(normalizedUserId),
      normalizedName,
      JSON.stringify(names.slice(-8)),
      JSON.stringify(confirmedNames.slice(-8)),
      confirmIdentity ? 1 : Number(existing?.identity_confirmed ?? 0),
      options.countMessage === false ? 0 : 1,
      currentTime,
      currentTime,
    );
    return true;
  }

  getGroupMemberAliases(groupId, limit = 40) {
    const rows = this.ensureOpen().prepare(`
      SELECT speaker_id, confirmed_names
      FROM qq_group_members
      WHERE group_id = ? AND identity_confirmed = 1
      ORDER BY last_seen_at DESC
      LIMIT ?
    `).all(String(groupId ?? '').trim(), limit);
    return Object.fromEntries(rows.map((row) => {
      const confirmedNames = safeNames(row.confirmed_names);
      return [row.speaker_id, confirmedNames.at(-1) ?? ''];
    }).filter(([, name]) => name));
  }

  getGroupMembers(groupId, limit = 40) {
    return this.ensureOpen().prepare(`
      SELECT user_id, speaker_id, current_name, known_names,
             confirmed_names, identity_confirmed, memory, message_count,
             first_seen_at, last_seen_at
      FROM qq_group_members
      WHERE group_id = ?
      ORDER BY last_seen_at DESC
      LIMIT ?
    `).all(String(groupId ?? '').trim(), limit).map((row) => ({
      userId: row.user_id,
      speakerId: row.speaker_id,
      currentName: row.current_name,
      knownNames: safeNames(row.known_names),
      confirmedNames: safeNames(row.confirmed_names),
      identityConfirmed: Boolean(row.identity_confirmed),
      memory: String(row.memory ?? '').trim(),
      messageCount: Number(row.message_count),
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at),
    }));
  }

  appendMemberObservation(groupId, userId, content) {
    const normalizedGroupId = String(groupId ?? '').trim();
    const normalizedUserId = String(userId ?? '').trim();
    const normalizedContent = shortenContent(String(content ?? '').trim(), 4_000);
    if (!normalizedGroupId || !normalizedUserId || !normalizedContent) return false;
    const database = this.ensureOpen();
    const member = database.prepare(`
      SELECT 1 FROM qq_group_members
      WHERE group_id = ? AND user_id = ?
    `).get(normalizedGroupId, normalizedUserId);
    if (!member) return false;

    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`
        INSERT INTO qq_group_member_observations(
          group_id, user_id, content, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(normalizedGroupId, normalizedUserId, normalizedContent, this.now());
      database.prepare(`
        DELETE FROM qq_group_member_observations
        WHERE group_id = ? AND user_id = ?
          AND id NOT IN (
            SELECT id FROM qq_group_member_observations
            WHERE group_id = ? AND user_id = ?
            ORDER BY id DESC
            LIMIT ?
          )
      `).run(
        normalizedGroupId,
        normalizedUserId,
        normalizedGroupId,
        normalizedUserId,
        this.maxMemberObservations,
      );
      database.exec('COMMIT');
      return true;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  getMemberMemorySnapshot(groupId, userId) {
    const normalizedGroupId = String(groupId ?? '').trim();
    const normalizedUserId = String(userId ?? '').trim();
    const database = this.ensureOpen();
    const member = database.prepare(`
      SELECT speaker_id, current_name, memory, memory_through_observation_id
      FROM qq_group_members
      WHERE group_id = ? AND user_id = ?
    `).get(normalizedGroupId, normalizedUserId);
    if (!member) return null;

    const previousThroughId = Number(member.memory_through_observation_id);
    const unsummarizedCount = Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM qq_group_member_observations
      WHERE group_id = ? AND user_id = ? AND id > ?
    `).get(normalizedGroupId, normalizedUserId, previousThroughId).count);
    if (unsummarizedCount < this.memberSummaryTriggerMessages) return null;

    const summarizeCount = Math.min(
      unsummarizedCount - this.memberSummaryKeepMessages,
      this.memberSummaryTriggerMessages - this.memberSummaryKeepMessages,
    );
    if (summarizeCount < 1) return null;
    const observations = database.prepare(`
      SELECT id, content
      FROM qq_group_member_observations
      WHERE group_id = ? AND user_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(
      normalizedGroupId,
      normalizedUserId,
      previousThroughId,
      summarizeCount,
    );
    if (observations.length === 0) return null;
    return {
      groupId: normalizedGroupId,
      userId: normalizedUserId,
      speakerId: String(member.speaker_id),
      currentName: String(member.current_name ?? '').trim(),
      previousMemory: String(member.memory ?? '').trim(),
      previousMemoryThroughObservationId: previousThroughId,
      memoryThroughObservationId: Number(observations.at(-1).id),
      observations: observations.map((observation) => String(observation.content)),
    };
  }

  scheduleMemberMemory(groupId, userId, summarizer) {
    if (typeof summarizer !== 'function') return Promise.resolve(false);
    const key = `${String(groupId ?? '').trim()}:${String(userId ?? '').trim()}`;
    const existing = this.pendingMemberSummaries.get(key);
    if (existing) return existing;
    const snapshot = this.getMemberMemorySnapshot(groupId, userId);
    if (!snapshot) return Promise.resolve(false);

    const task = Promise.resolve()
      .then(() => summarizer(snapshot))
      .then((memory) => {
        const normalized = /^(?:无|暂无|没有|none)$/i.test(String(memory ?? '').trim())
          ? ''
          : String(memory ?? '').trim();
        const database = this.ensureOpen();
        database.exec('BEGIN IMMEDIATE');
        try {
          const result = database.prepare(`
            UPDATE qq_group_members
            SET memory = ?, memory_through_observation_id = ?, memory_updated_at = ?
            WHERE group_id = ? AND user_id = ?
              AND memory_through_observation_id = ?
          `).run(
            shortenContent(normalized, this.maxMemberMemoryCharacters),
            snapshot.memoryThroughObservationId,
            this.now(),
            snapshot.groupId,
            snapshot.userId,
            snapshot.previousMemoryThroughObservationId,
          );
          if (Number(result.changes) > 0) {
            database.prepare(`
              DELETE FROM qq_group_member_observations
              WHERE group_id = ? AND user_id = ? AND id <= ?
            `).run(
              snapshot.groupId,
              snapshot.userId,
              snapshot.memoryThroughObservationId,
            );
          }
          database.exec('COMMIT');
          return Number(result.changes) > 0;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      })
      .catch((error) => {
        this.onPersistError(new Error('生成 QQ 群成员持久记忆失败：' + error.message));
        return false;
      })
      .finally(() => {
        if (this.pendingMemberSummaries.get(key) === task) {
          this.pendingMemberSummaries.delete(key);
        }
      });
    this.pendingMemberSummaries.set(key, task);
    return task;
  }

  getGroupMemberMemories(groupId, userIds = []) {
    const normalizedGroupId = String(groupId ?? '').trim();
    const normalizedUserIds = [...new Set(
      userIds.map((userId) => String(userId ?? '').trim()).filter(Boolean),
    )].slice(0, 20);
    if (!normalizedGroupId || normalizedUserIds.length === 0) return [];
    const placeholders = normalizedUserIds.map(() => '?').join(', ');
    return this.ensureOpen().prepare(`
      SELECT user_id, speaker_id, current_name, confirmed_names, memory
      FROM qq_group_members
      WHERE group_id = ? AND user_id IN (${placeholders}) AND memory <> ''
      ORDER BY last_seen_at DESC
    `).all(normalizedGroupId, ...normalizedUserIds).map((row) => ({
      userId: String(row.user_id),
      speakerId: String(row.speaker_id),
      name: safeNames(row.confirmed_names).at(-1) || String(row.current_name ?? '').trim(),
      memory: String(row.memory ?? '').trim(),
    }));
  }

  getGroupMemberHistory(groupId, userIds = [], limit = 12) {
    const normalizedGroupId = String(groupId ?? '').trim();
    const speakerIds = [...new Set(
      userIds
        .map((userId) => String(userId ?? '').trim())
        .filter(Boolean)
        .map(stableParticipantId),
    )].slice(0, 20);
    if (!normalizedGroupId || speakerIds.length === 0) return [];
    const patterns = speakerIds.map(() => 'content LIKE ?').join(' OR ');
    const rows = this.ensureOpen().prepare(`
      SELECT id, content, created_at
      FROM qq_messages
      WHERE conversation_id = ? AND role = 'user' AND (${patterns})
      ORDER BY id DESC
      LIMIT ?
    `).all(
      `group:${normalizedGroupId}`,
      ...speakerIds.map((speakerId) => `%成员-${speakerId}%`),
      normalizedPositiveInteger(limit, 12),
    );
    return rows.reverse().map((row) => ({
      id: Number(row.id),
      content: shortenContent(String(row.content ?? '').trim(), 1_200),
      createdAt: Number(row.created_at),
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
    await Promise.allSettled([
      ...this.pendingSummaries.values(),
      ...this.pendingMemberSummaries.values(),
    ]);
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
