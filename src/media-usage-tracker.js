import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function nonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

/**
 * Video extraction has a different cost shape from LLM calls. Keep it in a
 * separate SQLite file so download bytes, resolver calls and failures cannot
 * be mistaken for model tokens.
 */
export class MediaUsageTracker {
  constructor({ databaseFilePath = 'data/qq-media-usage.sqlite', now = Date.now } = {}) {
    this.databaseFilePath = String(databaseFilePath).trim();
    this.now = now;
    this.database = null;
  }

  ensureOpen() {
    if (this.database) return this.database;
    if (!this.databaseFilePath) throw new Error('媒体用量数据库路径不能为空');
    mkdirSync(path.dirname(this.databaseFilePath), { recursive: true });
    this.database = new DatabaseSync(this.databaseFilePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS media_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        group_id TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT '',
        operation TEXT NOT NULL DEFAULT 'resolve',
        status TEXT NOT NULL DEFAULT 'success',
        source_url_hash TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        download_bytes INTEGER NOT NULL DEFAULT 0,
        output_bytes INTEGER NOT NULL DEFAULT 0,
        error_stage TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS media_usage_events_created ON media_usage_events(created_at);
      CREATE INDEX IF NOT EXISTS media_usage_events_provider ON media_usage_events(provider, created_at);
    `);
    return this.database;
  }

  record(event = {}) {
    const db = this.ensureOpen();
    db.prepare(`INSERT INTO media_usage_events(
      created_at, group_id, user_id, provider, operation, status,
      source_url_hash, duration_ms, download_bytes, output_bytes, error_stage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      nonnegative(event.createdAt) || this.now(),
      String(event.groupId ?? '').slice(0, 128),
      String(event.userId ?? '').slice(0, 128),
      String(event.provider ?? '').slice(0, 64),
      String(event.operation ?? 'resolve').slice(0, 32),
      String(event.status ?? 'success').slice(0, 32),
      String(event.sourceUrlHash ?? '').slice(0, 128),
      nonnegative(event.durationMs),
      nonnegative(event.downloadBytes),
      nonnegative(event.outputBytes),
      String(event.errorStage ?? '').slice(0, 64),
    );
  }

  getReport({ startAt = 0, endAt = this.now() } = {}) {
    const db = this.ensureOpen();
    const rows = db.prepare(`SELECT provider, status, COUNT(*) AS requests,
      COALESCE(SUM(download_bytes), 0) AS downloadBytes,
      COALESCE(SUM(output_bytes), 0) AS outputBytes,
      COALESCE(SUM(duration_ms), 0) AS durationMs
      FROM media_usage_events WHERE created_at >= ? AND created_at < ?
      GROUP BY provider, status ORDER BY requests DESC`).all(nonnegative(startAt), nonnegative(endAt));
    const totals = rows.reduce((sum, row) => ({
      requests: sum.requests + Number(row.requests || 0),
      downloadBytes: sum.downloadBytes + Number(row.downloadBytes || 0),
      outputBytes: sum.outputBytes + Number(row.outputBytes || 0),
      durationMs: sum.durationMs + Number(row.durationMs || 0),
    }), { requests: 0, downloadBytes: 0, outputBytes: 0, durationMs: 0 });
    return { totals, byProvider: rows };
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}
