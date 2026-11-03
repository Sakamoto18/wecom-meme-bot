import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const TASK_STATUSES = new Set([
  'queued', 'searching', 'watching', 'reviewing', 'completed', 'failed', 'cancelled',
]);
const DELIVERY_STATUSES = new Set(['pending', 'leased', 'sent', 'failed']);
const DELIVERY_KINDS = new Set(['reminder', 'result', 'failure']);
const MAX_TEXT = 4_000;

function text(value, limit = MAX_TEXT) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
}

function json(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function jsonText(value) {
  return JSON.stringify(value && typeof value === 'object' ? value : {});
}

function positiveInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeTask(input = {}) {
  const topicKey = text(input.topicKey || input.topic, 240).toLowerCase();
  const topic = text(input.topic || input.topicKey, 240);
  if (!topicKey || !topic) return null;
  return {
    // A topic can be relearned after a failure, so the key is per attempt.
    taskKey: text(input.taskKey, 320).toLowerCase(),
    topicKey,
    topic,
    groupId: text(input.groupId, 80),
    userId: text(input.userId, 80),
    messageId: text(input.messageId, 160),
    conversationId: text(input.conversationId, 160),
    question: text(input.question, 2_000),
    context: text(input.context, 4_000),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
  };
}

export class VideoLearningStore {
  constructor(options = {}) {
    this.databaseFilePath = text(options.databaseFilePath, 500);
    this.now = options.now ?? Date.now;
    this.database = null;
  }

  ensureOpen() {
    if (this.database) return this.database;
    if (!this.databaseFilePath) throw new Error('视频学习数据库路径不能为空');
    mkdirSync(path.dirname(this.databaseFilePath), { recursive: true });
    this.database = new DatabaseSync(this.databaseFilePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS video_learning_tasks (
        task_key TEXT PRIMARY KEY,
        topic_key TEXT NOT NULL,
        topic TEXT NOT NULL,
        group_id TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        message_id TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL DEFAULT '',
        question TEXT NOT NULL DEFAULT '',
        context TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        result_json TEXT NOT NULL DEFAULT '{}',
        error_text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS video_learning_tasks_topic ON video_learning_tasks(topic_key, status);
      CREATE INDEX IF NOT EXISTS video_learning_tasks_updated ON video_learning_tasks(updated_at);

      CREATE TABLE IF NOT EXISTS video_learning_deliveries (
        delivery_id TEXT PRIMARY KEY,
        task_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0,
        error_text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS video_learning_deliveries_claim
        ON video_learning_deliveries(status, lease_until, created_at);
      CREATE INDEX IF NOT EXISTS video_learning_deliveries_task
        ON video_learning_deliveries(task_key, kind);

      CREATE TABLE IF NOT EXISTS video_learning_sources (
        source_key TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'bilibili',
        bvid TEXT NOT NULL DEFAULT '',
        cid TEXT NOT NULL DEFAULT '',
        page INTEGER NOT NULL DEFAULT 1,
        url TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS video_learning_sources_bvid ON video_learning_sources(bvid, cid, page);

      CREATE TABLE IF NOT EXISTS video_learning_observations (
        observation_id TEXT PRIMARY KEY,
        task_key TEXT NOT NULL,
        source_key TEXT NOT NULL,
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS video_learning_observations_task
        ON video_learning_observations(task_key, source_key, start_seconds);

      CREATE TABLE IF NOT EXISTS video_learning_catchup_runs (
        day TEXT PRIMARY KEY,
        run_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    return this.database;
  }

  #taskRow(row) {
    if (!row) return null;
    return {
      taskKey: row.task_key,
      topicKey: row.topic_key,
      topic: row.topic,
      groupId: row.group_id,
      userId: row.user_id,
      messageId: row.message_id,
      conversationId: row.conversation_id,
      question: row.question,
      context: row.context,
      status: row.status,
      metadata: json(row.metadata_json),
      result: json(row.result_json),
      error: row.error_text,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at || 0,
    };
  }

  #deliveryRow(row) {
    if (!row) return null;
    return {
      deliveryId: row.delivery_id,
      taskKey: row.task_key,
      kind: row.kind,
      status: row.status,
      payload: json(row.payload_json),
      attempts: Number(row.attempts || 0),
      leaseUntil: Number(row.lease_until || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sentAt: row.sent_at || 0,
    };
  }

  findActiveTask(topicKey) {
    const key = text(topicKey, 240).toLowerCase();
    if (!key) return null;
    const row = this.ensureOpen().prepare(`
      SELECT * FROM video_learning_tasks
      WHERE topic_key = ? AND status IN ('queued', 'searching', 'watching', 'reviewing')
      ORDER BY updated_at DESC LIMIT 1
    `).get(key);
    return this.#taskRow(row);
  }

  createOrJoinTask(input = {}) {
    const task = normalizeTask(input);
    if (!task) throw new Error('视频学习任务缺少主题');
    const existing = this.findActiveTask(task.topicKey);
    if (existing) return { task: existing, joined: true };
    const now = this.now();
    const db = this.ensureOpen();
    const taskKey = task.taskKey || `${task.topicKey}:${now}`;
    db.prepare(`
      INSERT INTO video_learning_tasks(
        task_key, topic_key, topic, group_id, user_id, message_id,
        conversation_id, question, context, status, metadata_json,
        result_json, error_text, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, '{}', '', ?, ?, NULL)
    `).run(
      taskKey, task.topicKey, task.topic, task.groupId, task.userId, task.messageId,
      task.conversationId, task.question, task.context, jsonText(task.metadata), now, now,
    );
    return { task: this.getTask(taskKey), joined: false };
  }

  getTask(taskKey) {
    const row = this.ensureOpen().prepare(
      'SELECT * FROM video_learning_tasks WHERE task_key = ?',
    ).get(text(taskKey, 320).toLowerCase());
    return this.#taskRow(row);
  }

  updateTask(taskKey, patch = {}) {
    const key = text(taskKey, 320).toLowerCase();
    const current = this.getTask(key);
    if (!current) return null;
    const status = patch.status === undefined ? current.status : String(patch.status);
    if (!TASK_STATUSES.has(status)) throw new Error(`无效的视频学习任务状态：${status}`);
    const now = this.now();
    const result = patch.result === undefined ? current.result : patch.result;
    const metadata = patch.metadata === undefined ? current.metadata : patch.metadata;
    const error = patch.error === undefined ? current.error : text(patch.error, 2_000);
    const completedAt = ['completed', 'failed', 'cancelled'].includes(status)
      ? (current.completedAt || now) : null;
    this.ensureOpen().prepare(`
      UPDATE video_learning_tasks
      SET status = ?, metadata_json = ?, result_json = ?, error_text = ?,
          updated_at = ?, completed_at = ?
      WHERE task_key = ?
    `).run(status, jsonText(metadata), jsonText(result), error, now, completedAt, key);
    return this.getTask(key);
  }

  enqueueDelivery(taskKey, kind, payload = {}) {
    const key = text(taskKey, 320).toLowerCase();
    if (!this.getTask(key)) throw new Error('视频学习任务不存在');
    if (!DELIVERY_KINDS.has(kind)) throw new Error(`无效的视频学习投递类型：${kind}`);
    // One pending delivery per task, kind and waiter (each asker gets a reply).
    const existing = this.ensureOpen().prepare(`
      SELECT * FROM video_learning_deliveries
      WHERE task_key = ? AND kind = ? AND status IN ('pending', 'leased')
        AND COALESCE(json_extract(payload_json, '$.waiterKey'), '') = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(key, kind, text(payload?.waiterKey, 240));
    if (existing) return this.#deliveryRow(existing);
    const now = this.now();
    const id = randomUUID();
    this.ensureOpen().prepare(`
      INSERT INTO video_learning_deliveries(
        delivery_id, task_key, kind, status, payload_json, attempts,
        lease_until, created_at, updated_at, sent_at
      ) VALUES (?, ?, ?, 'pending', ?, 0, 0, ?, ?, NULL)
    `).run(id, key, kind, jsonText(payload), now, now);
    return this.getDelivery(id);
  }

  getDelivery(deliveryId) {
    const row = this.ensureOpen().prepare(
      'SELECT * FROM video_learning_deliveries WHERE delivery_id = ?',
    ).get(text(deliveryId, 80));
    return this.#deliveryRow(row);
  }

  claimDeliveries(limit = 10, leaseMs = 30_000) {
    const count = Math.max(1, Math.min(50, positiveInteger(limit, 10)));
    const now = this.now();
    const leaseUntil = now + Math.max(1_000, positiveInteger(leaseMs, 30_000));
    const db = this.ensureOpen();
    const rows = db.prepare(`
      SELECT delivery_id FROM video_learning_deliveries
      WHERE (status = 'pending' OR (status = 'leased' AND lease_until <= ?))
      ORDER BY created_at ASC LIMIT ?
    `).all(now, count);
    const claimed = [];
    for (const row of rows) {
      const result = db.prepare(`
        UPDATE video_learning_deliveries
        SET status = 'leased', attempts = attempts + 1, lease_until = ?, updated_at = ?
        WHERE delivery_id = ? AND (status = 'pending' OR (status = 'leased' AND lease_until <= ?))
      `).run(leaseUntil, now, row.delivery_id, now);
      if (result.changes > 0) claimed.push(this.getDelivery(row.delivery_id));
    }
    return claimed;
  }

  completeDelivery(deliveryId, { sent = true, error = '' } = {}) {
    const id = text(deliveryId, 80);
    const now = this.now();
    const status = sent ? 'sent' : 'failed';
    this.ensureOpen().prepare(`
      UPDATE video_learning_deliveries
      SET status = ?, error_text = ?, lease_until = 0, updated_at = ?, sent_at = ?
      WHERE delivery_id = ?
    `).run(status, text(error, 2_000), now, sent ? now : null, id);
    return this.getDelivery(id);
  }

  rememberSource(input = {}) {
    const bvid = text(input.bvid, 80);
    const cid = text(input.cid, 80);
    const page = positiveInteger(input.page, 1);
    const sourceKey = text(input.sourceKey || [bvid, cid, page].filter(Boolean).join(':'), 240);
    if (!sourceKey) throw new Error('视频学习来源缺少 sourceKey');
    const now = this.now();
    this.ensureOpen().prepare(`
      INSERT INTO video_learning_sources(
        source_key, provider, bvid, cid, page, url, title, duration_seconds,
        metadata_json, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        url=excluded.url, title=excluded.title, duration_seconds=excluded.duration_seconds,
        metadata_json=excluded.metadata_json, last_seen_at=excluded.last_seen_at
    `).run(
      sourceKey, text(input.provider || 'bilibili', 40), bvid, cid, page,
      text(input.url, 1_000), text(input.title, 500), positiveInteger(input.durationSeconds),
      jsonText(input.metadata), now, now,
    );
    return this.getSource(sourceKey);
  }

  getSource(sourceKey) {
    const row = this.ensureOpen().prepare(
      'SELECT * FROM video_learning_sources WHERE source_key = ?',
    ).get(text(sourceKey, 240));
    if (!row) return null;
    return {
      sourceKey: row.source_key,
      provider: row.provider,
      bvid: row.bvid,
      cid: row.cid,
      page: row.page,
      url: row.url,
      title: row.title,
      durationSeconds: row.duration_seconds,
      metadata: json(row.metadata_json),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  addObservation(input = {}) {
    const taskKey = text(input.taskKey, 320).toLowerCase();
    const sourceKey = text(input.sourceKey, 240);
    if (!taskKey || !sourceKey) throw new Error('视频观察记录缺少任务或来源');
    const start = Math.max(0, Number(input.startSeconds) || 0);
    const end = Math.max(start, Number(input.endSeconds) || start);
    const id = randomUUID();
    this.ensureOpen().prepare(`
      INSERT INTO video_learning_observations(
        observation_id, task_key, source_key, start_seconds, end_seconds,
        evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, taskKey, sourceKey, start, end, jsonText(input.evidence), this.now());
    return { observationId: id, taskKey, sourceKey, startSeconds: start, endSeconds: end, evidence: input.evidence ?? {} };
  }

  findLatestTask(topicKey, status, since = 0) {
    const row = this.ensureOpen().prepare(`
      SELECT * FROM video_learning_tasks
      WHERE topic_key = ? AND status = ? AND updated_at >= ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(text(topicKey, 240).toLowerCase(), String(status), Number(since) || 0);
    return this.#taskRow(row);
  }

  nextQueuedTask() {
    return this.#taskRow(this.ensureOpen().prepare(`
      SELECT * FROM video_learning_tasks WHERE status = 'queued'
      ORDER BY created_at ASC LIMIT 1
    `).get());
  }

  countTasksSince(since) {
    return Number(this.ensureOpen().prepare(
      'SELECT COUNT(*) AS count FROM video_learning_tasks WHERE created_at >= ?',
    ).get(Number(since) || 0).count);
  }

  materialSecondsSince(since) {
    return Number(this.ensureOpen().prepare(`
      SELECT COALESCE(SUM(json_extract(result_json, '$.materialSeconds')), 0) AS seconds
      FROM video_learning_tasks WHERE completed_at >= ?
    `).get(Number(since) || 0).seconds) || 0;
  }

  // Tasks interrupted by a restart go back to the queue.
  requeueInterrupted() {
    return Number(this.ensureOpen().prepare(`
      UPDATE video_learning_tasks SET status = 'queued', updated_at = ?
      WHERE status IN ('searching', 'watching', 'reviewing')
    `).run(this.now()).changes);
  }

  hasSource(sourceKey) {
    return Boolean(this.getSource(sourceKey));
  }

  getCatchupRun(day) {
    const row = this.ensureOpen().prepare(
      'SELECT run_json FROM video_learning_catchup_runs WHERE day = ?',
    ).get(text(day, 20));
    return row ? json(row.run_json) : null;
  }

  saveCatchupRun(day, run = {}) {
    this.ensureOpen().prepare(`
      INSERT INTO video_learning_catchup_runs(day, run_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET run_json = excluded.run_json, updated_at = excluded.updated_at
    `).run(text(day, 20), jsonText(run), this.now());
  }

  latestCatchupRun() {
    const row = this.ensureOpen().prepare(
      'SELECT run_json FROM video_learning_catchup_runs ORDER BY day DESC LIMIT 1',
    ).get();
    return row ? json(row.run_json) : null;
  }

  getStats() {
    const db = this.ensureOpen();
    const count = (table, where = '') => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get().count);
    return {
      tasks: count('video_learning_tasks'),
      activeTasks: count('video_learning_tasks', " WHERE status IN ('queued','searching','watching','reviewing')"),
      deliveries: count('video_learning_deliveries'),
      pendingDeliveries: count('video_learning_deliveries', " WHERE status IN ('pending','leased')"),
      sources: count('video_learning_sources'),
      observations: count('video_learning_observations'),
    };
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

