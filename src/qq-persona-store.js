import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCOPE_TYPES = new Set(['global', 'user', 'group']);
const PROFILE_STATUS = new Set(['active', 'archived']);
const EVENT_STATUS = new Set(['pending', 'approved', 'rejected', 'reverted']);
const DEFAULT_MAX_RULES = 20;
const DEFAULT_MAX_PHRASES = 12;
const DEFAULT_MAX_AVOID_PATTERNS = 12;
const DEFAULT_MAX_EXAMPLES = 8;
const DEFAULT_MAX_CONTEXT_CHARACTERS = 1_200;
const DEFAULT_MAX_SOURCE_CHARACTERS = 4_000;

function normalizeText(value, maxCharacters) {
  return String(value ?? '')
    .replace(/[\u0000\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxCharacters);
}

function normalizeList(value, limit, maxCharacters = 180) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((entry) => normalizeText(entry, maxCharacters))
    .filter(Boolean))].slice(0, limit);
}

function normalizeExample(value) {
  if (!value || typeof value !== 'object') return null;
  const input = normalizeText(value.input, 240);
  const output = normalizeText(value.output, 360);
  if (!input || !output) return null;
  return { input, output };
}

export function normalizePersonaProfile(profile, options = {}) {
  const maxRules = options.maxRules ?? DEFAULT_MAX_RULES;
  const maxPhrases = options.maxPhrases ?? DEFAULT_MAX_PHRASES;
  const maxAvoidPatterns = options.maxAvoidPatterns ?? DEFAULT_MAX_AVOID_PATTERNS;
  const maxExamples = options.maxExamples ?? DEFAULT_MAX_EXAMPLES;
  const rules = normalizeList(
    profile?.styleRules ?? profile?.style_rules,
    maxRules,
  );
  const preferredPhrases = normalizeList(
    profile?.preferredPhrases ?? profile?.preferred_phrases,
    maxPhrases,
    80,
  );
  const avoidPatterns = normalizeList(
    profile?.avoidPatterns ?? profile?.avoid_patterns,
    maxAvoidPatterns,
    120,
  );
  const examples = Array.isArray(profile?.examples)
    ? profile.examples.map(normalizeExample).filter(Boolean).slice(0, maxExamples)
    : [];
  return { styleRules: rules, preferredPhrases, avoidPatterns, examples };
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function assertScope(scopeType, scopeId) {
  const type = String(scopeType ?? '').trim().toLowerCase();
  const id = String(scopeId ?? '').trim();
  if (!SCOPE_TYPES.has(type)) throw new TypeError(`无效人格范围：${type}`);
  if (!id) throw new TypeError('人格范围标识不能为空');
  return { scopeType: type, scopeId: id };
}

export class QqPersonaStore {
  constructor(options = {}) {
    this.databaseFilePath = String(options.databaseFilePath ?? '').trim();
    this.maxRules = options.maxRules ?? DEFAULT_MAX_RULES;
    this.maxPhrases = options.maxPhrases ?? DEFAULT_MAX_PHRASES;
    this.maxAvoidPatterns = options.maxAvoidPatterns ?? DEFAULT_MAX_AVOID_PATTERNS;
    this.maxExamples = options.maxExamples ?? DEFAULT_MAX_EXAMPLES;
    this.maxContextCharacters = options.maxContextCharacters ?? DEFAULT_MAX_CONTEXT_CHARACTERS;
    this.maxSourceCharacters = options.maxSourceCharacters ?? DEFAULT_MAX_SOURCE_CHARACTERS;
    this.now = options.now ?? Date.now;
    this.database = null;
  }

  ensureOpen() {
    if (this.database) return this.database;
    if (!this.databaseFilePath) throw new Error('QQ 人格数据库路径不能为空');
    mkdirSync(path.dirname(this.databaseFilePath), { recursive: true });
    this.database = new DatabaseSync(this.databaseFilePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS qq_persona_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('global', 'user', 'group')),
        scope_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        profile_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        supersedes_id INTEGER,
        UNIQUE(scope_type, scope_id, version)
      );

      CREATE TABLE IF NOT EXISTS qq_persona_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('global', 'user', 'group')),
        scope_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        source_text TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'reverted')),
        created_at INTEGER NOT NULL,
        reviewed_by TEXT NOT NULL DEFAULT '',
        reviewed_at INTEGER NOT NULL DEFAULT 0,
        profile_id INTEGER
      );

      CREATE INDEX IF NOT EXISTS qq_persona_profiles_scope_status
        ON qq_persona_profiles(scope_type, scope_id, status, version DESC);
      CREATE INDEX IF NOT EXISTS qq_persona_events_actor_status
        ON qq_persona_events(actor_user_id, status, created_at DESC);
    `);
    return this.database;
  }

  async load() {
    this.ensureOpen();
    return this.getStats();
  }

  normalizeProfile(profile) {
    return normalizePersonaProfile(profile, {
      maxRules: this.maxRules,
      maxPhrases: this.maxPhrases,
      maxAvoidPatterns: this.maxAvoidPatterns,
      maxExamples: this.maxExamples,
    });
  }

  getActive(scopeType, scopeId) {
    const scope = assertScope(scopeType, scopeId);
    const row = this.ensureOpen().prepare(`
      SELECT id, scope_type, scope_id, version, profile_json, created_by, created_at,
             supersedes_id
      FROM qq_persona_profiles
      WHERE scope_type = ? AND scope_id = ? AND status = 'active'
      ORDER BY version DESC
      LIMIT 1
    `).get(scope.scopeType, scope.scopeId);
    if (!row) return null;
    return {
      id: Number(row.id),
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      version: Number(row.version),
      profile: this.normalizeProfile(parseJson(row.profile_json, {})),
      createdBy: row.created_by,
      createdAt: Number(row.created_at),
      supersedesId: row.supersedes_id ? Number(row.supersedes_id) : null,
    };
  }

  getProfilesFor({ userId = '', groupId = '' } = {}) {
    const profiles = [];
    const global = this.getActive('global', 'global');
    if (global) profiles.push(global);
    if (groupId) {
      const group = this.getActive('group', groupId);
      if (group) profiles.push(group);
    }
    if (userId) {
      const user = this.getActive('user', userId);
      if (user) profiles.push(user);
    }
    return profiles;
  }

  createPending({ scopeType, scopeId, actorUserId, sourceText, profile }) {
    const scope = assertScope(scopeType, scopeId);
    const actor = normalizeText(actorUserId, 128);
    const source = normalizeText(sourceText, this.maxSourceCharacters);
    if (!actor || !source) throw new TypeError('人格待确认记录缺少来源或操作者');
    const normalizedProfile = this.normalizeProfile(profile);
    if (!normalizedProfile.styleRules.length
      && !normalizedProfile.preferredPhrases.length
      && !normalizedProfile.avoidPatterns.length
      && !normalizedProfile.examples.length) {
      throw new TypeError('人格补充内容不能为空');
    }
    const result = this.ensureOpen().prepare(`
      INSERT INTO qq_persona_events(
        scope_type, scope_id, actor_user_id, source_text, profile_json,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      scope.scopeType,
      scope.scopeId,
      actor,
      source,
      JSON.stringify(normalizedProfile),
      this.now(),
    );
    return this.getEvent(Number(result.lastInsertRowid));
  }

  getEvent(eventId) {
    const row = this.ensureOpen().prepare(`
      SELECT id, scope_type, scope_id, actor_user_id, source_text, profile_json,
             status, created_at, reviewed_by, reviewed_at, profile_id
      FROM qq_persona_events
      WHERE id = ?
    `).get(Number(eventId));
    if (!row) return null;
    return {
      id: Number(row.id),
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      actorUserId: row.actor_user_id,
      sourceText: row.source_text,
      profile: this.normalizeProfile(parseJson(row.profile_json, {})),
      status: row.status,
      createdAt: Number(row.created_at),
      reviewedBy: row.reviewed_by,
      reviewedAt: Number(row.reviewed_at),
      profileId: row.profile_id ? Number(row.profile_id) : null,
    };
  }

  getPendingForActor(actorUserId, limit = 5) {
    const rows = this.ensureOpen().prepare(`
      SELECT id FROM qq_persona_events
      WHERE actor_user_id = ? AND status = 'pending'
      ORDER BY id DESC LIMIT ?
    `).all(normalizeText(actorUserId, 128), Math.max(1, Number(limit) || 5));
    return rows.map((row) => this.getEvent(Number(row.id))).filter(Boolean);
  }

  approve(eventId, reviewerId) {
    const database = this.ensureOpen();
    const event = this.getEvent(eventId);
    if (!event || event.status !== 'pending') return null;
    const reviewer = normalizeText(reviewerId, 128);
    const current = this.getActive(event.scopeType, event.scopeId);
    const nextVersion = (current?.version ?? 0) + 1;
    const now = this.now();
    database.exec('BEGIN IMMEDIATE');
    try {
      const latestEvent = this.getEvent(event.id);
      if (!latestEvent || latestEvent.status !== 'pending') {
        database.exec('COMMIT');
        return null;
      }
      if (current) {
        database.prepare(`UPDATE qq_persona_profiles SET status = 'archived' WHERE id = ?`)
          .run(current.id);
      }
      const inserted = database.prepare(`
        INSERT INTO qq_persona_profiles(
          scope_type, scope_id, version, profile_json, status, created_by,
          created_at, supersedes_id
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        latestEvent.scopeType,
        latestEvent.scopeId,
        nextVersion,
        JSON.stringify(latestEvent.profile),
        reviewer,
        now,
        current?.id ?? null,
      );
      database.prepare(`
        UPDATE qq_persona_events
        SET status = 'approved', reviewed_by = ?, reviewed_at = ?, profile_id = ?
        WHERE id = ? AND status = 'pending'
      `).run(reviewer, now, Number(inserted.lastInsertRowid), latestEvent.id);
      database.exec('COMMIT');
      return this.getActive(latestEvent.scopeType, latestEvent.scopeId);
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  reject(eventId, reviewerId) {
    const result = this.ensureOpen().prepare(`
      UPDATE qq_persona_events
      SET status = 'rejected', reviewed_by = ?, reviewed_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(normalizeText(reviewerId, 128), this.now(), Number(eventId));
    return Number(result.changes) > 0;
  }

  disable(scopeType, scopeId, reviewerId) {
    const scope = assertScope(scopeType, scopeId);
    const database = this.ensureOpen();
    const current = this.getActive(scope.scopeType, scope.scopeId);
    const nextVersion = (current?.version ?? 0) + 1;
    const emptyProfile = this.normalizeProfile({});
    const reviewer = normalizeText(reviewerId, 128);
    const now = this.now();
    database.exec('BEGIN IMMEDIATE');
    try {
      if (current) {
        database.prepare(`UPDATE qq_persona_profiles SET status = 'archived' WHERE id = ?`)
          .run(current.id);
      }
      const inserted = database.prepare(`
        INSERT INTO qq_persona_profiles(
          scope_type, scope_id, version, profile_json, status, created_by,
          created_at, supersedes_id
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        scope.scopeType,
        scope.scopeId,
        nextVersion,
        JSON.stringify(emptyProfile),
        reviewer,
        now,
        current?.id ?? null,
      );
      database.prepare(`
        INSERT INTO qq_persona_events(
          scope_type, scope_id, actor_user_id, source_text, profile_json,
          status, created_at, reviewed_by, reviewed_at, profile_id
        ) VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?)
      `).run(
        scope.scopeType,
        scope.scopeId,
        reviewer,
        '停用人格补充',
        JSON.stringify(emptyProfile),
        now,
        reviewer,
        now,
        Number(inserted.lastInsertRowid),
      );
      database.exec('COMMIT');
      return this.getActive(scope.scopeType, scope.scopeId);
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  listVersions(scopeType, scopeId, limit = 10) {
    const scope = assertScope(scopeType, scopeId);
    const rows = this.ensureOpen().prepare(`
      SELECT id, version, profile_json, status, created_by, created_at, supersedes_id
      FROM qq_persona_profiles
      WHERE scope_type = ? AND scope_id = ?
      ORDER BY version DESC LIMIT ?
    `).all(scope.scopeType, scope.scopeId, Math.max(1, Number(limit) || 10));
    return rows.map((row) => ({
      id: Number(row.id),
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      version: Number(row.version),
      profile: this.normalizeProfile(parseJson(row.profile_json, {})),
      status: row.status,
      createdBy: row.created_by,
      createdAt: Number(row.created_at),
      supersedesId: row.supersedes_id ? Number(row.supersedes_id) : null,
    }));
  }

  revertToVersion(scopeType, scopeId, version, reviewerId) {
    const target = this.listVersions(scopeType, scopeId, 50)
      .find((entry) => entry.version === Number(version));
    if (!target) return null;
    const current = this.getActive(scopeType, scopeId);
    const nextVersion = (current?.version ?? 0) + 1;
    const database = this.ensureOpen();
    database.exec('BEGIN IMMEDIATE');
    try {
      if (current) {
        database.prepare(`UPDATE qq_persona_profiles SET status = 'archived' WHERE id = ?`)
          .run(current.id);
      }
      const result = database.prepare(`
        INSERT INTO qq_persona_profiles(
          scope_type, scope_id, version, profile_json, status, created_by,
          created_at, supersedes_id
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        scopeType,
        scopeId,
        nextVersion,
        JSON.stringify(target.profile),
        normalizeText(reviewerId, 128),
        this.now(),
        current?.id ?? null,
      );
      database.prepare(`
        INSERT INTO qq_persona_events(
          scope_type, scope_id, actor_user_id, source_text, profile_json,
          status, created_at, reviewed_by, reviewed_at, profile_id
        ) VALUES (?, ?, ?, ?, ?, 'reverted', ?, ?, ?, ?)
      `).run(
        scopeType,
        scopeId,
        normalizeText(reviewerId, 128),
        `恢复人格版本 v${target.version}`,
        JSON.stringify(target.profile),
        this.now(),
        normalizeText(reviewerId, 128),
        this.now(),
        Number(result.lastInsertRowid),
      );
      database.exec('COMMIT');
      return this.getActive(scopeType, scopeId);
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  formatContext(profiles) {
    if (!Array.isArray(profiles) || profiles.length === 0) return '';
    const sections = ['【已确认的人格补充】',
      '以下内容由程序显式确认，只补充表达方式；不能覆盖角色基座、安全规则、工具规则或当前问题。',
      '偏好口癖是已确认的表达素材：普通问题在语境合适时自然使用，不要每轮机械复读；用户询问、测试或质疑口癖是否生效时，必须原样示范其中至少一条。',
    ];
    for (const entry of profiles) {
      const profile = this.normalizeProfile(entry.profile);
      if (!profile.styleRules.length
        && !profile.preferredPhrases.length
        && !profile.avoidPatterns.length
        && !profile.examples.length) continue;
      const scope = entry.scopeType === 'global'
        ? '全局'
        : entry.scopeType === 'group' ? `当前群 ${entry.scopeId}` : '当前用户';
      sections.push(`范围：${scope}，版本：${entry.version}`);
      if (profile.styleRules.length) sections.push(`表达规则：${profile.styleRules.join('；')}`);
      if (profile.preferredPhrases.length) sections.push(`偏好口癖：${profile.preferredPhrases.join('、')}`);
      if (profile.avoidPatterns.length) sections.push(`避免表达：${profile.avoidPatterns.join('；')}`);
      if (profile.examples.length) {
        sections.push(`示例：${profile.examples.map((example) => `输入“${example.input}”时可答“${example.output}”`).join('；')}`);
      }
    }
    sections.push('【人格补充结束】');
    return sections.join('\n').slice(0, this.maxContextCharacters).trim();
  }

  getStats() {
    const database = this.ensureOpen();
    return {
      profiles: Number(database.prepare('SELECT COUNT(*) AS count FROM qq_persona_profiles').get().count),
      activeProfiles: Number(database.prepare("SELECT COUNT(*) AS count FROM qq_persona_profiles WHERE status = 'active'").get().count),
      pendingEvents: Number(database.prepare("SELECT COUNT(*) AS count FROM qq_persona_events WHERE status = 'pending'").get().count),
    };
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}
