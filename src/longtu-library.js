import { createHash, randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  extractImageFeatures,
  extractPerceptualHashes,
  minimumFeatureDistance,
  minimumPerceptualHashDistance,
} from './image-features.js';
import { normalizeLongtuAlias } from './longtu-management.js';
import { detectImageExtension } from './meme-store.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const AUTO_ACCEPT_DISTANCE = 0.22;
const AMBIGUOUS_DISTANCE = 0.34;
const NEAR_DUPLICATE_HASH_DISTANCE = 2;
const SCENE_HASH_DISTANCE = 6;
const RECENT_SCENE_WINDOW = 12;

function shortIdForHash(sha256) {
  return `LT-${sha256.slice(0, 8).toUpperCase()}`;
}

function shufflePick(values) {
  return values[randomInt(values.length)];
}

function normalizeScope(value) {
  return String(value ?? '').trim().slice(0, 256) || 'global';
}

function normalizeActor(value) {
  return String(value ?? '').trim().slice(0, 128) || 'unknown';
}

function parseHashes(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed.filter((hash) => /^[a-f0-9]{16}$/i.test(hash))
      : [];
  } catch {
    return [];
  }
}

function serializeFeatureViews(featureViews) {
  return featureViews.map((view) => ({
    normalized: Array.from(view.normalized),
    edges: Array.from(view.edges),
    histogram: Array.from(view.histogram),
    chroma: view.chroma,
  }));
}

function deserializeFeatureViews(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((view) => ({
      normalized: Float32Array.from(view.normalized ?? []),
      edges: Float32Array.from(view.edges ?? []),
      histogram: Float32Array.from(view.histogram ?? []),
      chroma: Number(view.chroma) || 0,
    }));
  } catch {
    return null;
  }
}

export class LongtuLibrary {
  constructor(options = {}) {
    this.databaseFilePath = options.databaseFilePath?.trim() || '';
    this.assetsDirectory = options.assetsDirectory?.trim() || '';
    this.seedAliasesFilePath = options.seedAliasesFilePath?.trim() || '';
    this.now = options.now ?? Date.now;
    this.database = null;
    this.referenceFeatures = new Map();
  }

  ensureOpen() {
    if (this.database) return this.database;
    if (!this.databaseFilePath || !this.assetsDirectory) {
      throw new Error('龙图库数据库或动态素材目录未配置');
    }
    mkdirSync(path.dirname(this.databaseFilePath), { recursive: true });
    mkdirSync(this.assetsDirectory, { recursive: true });
    this.database = new DatabaseSync(this.databaseFilePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS longtu_assets (
        sha256 TEXT PRIMARY KEY,
        short_id TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        extension TEXT NOT NULL,
        perceptual_hashes TEXT NOT NULL,
        feature_views TEXT,
        added_by TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        deleted_at INTEGER,
        deleted_by TEXT
      );

      CREATE TABLE IF NOT EXISTS longtu_catalog_features (
        sha256 TEXT PRIMARY KEY,
        perceptual_hashes TEXT NOT NULL,
        feature_views TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS longtu_blocklist (
        sha256 TEXT PRIMARY KEY,
        short_id TEXT NOT NULL,
        deleted_by TEXT NOT NULL,
        deleted_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS longtu_selection_state (
        scope TEXT NOT NULL,
        pool_key TEXT NOT NULL,
        cycle INTEGER NOT NULL,
        PRIMARY KEY(scope, pool_key)
      );

      CREATE TABLE IF NOT EXISTS longtu_selections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        pool_key TEXT NOT NULL,
        cycle INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        scene_id TEXT NOT NULL,
        selected_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS longtu_aliases (
        alias TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        source TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        deleted_by TEXT
      );

      CREATE INDEX IF NOT EXISTS longtu_selections_scope_pool_cycle
        ON longtu_selections(scope, pool_key, cycle);
      CREATE INDEX IF NOT EXISTS longtu_selections_scope_id
        ON longtu_selections(scope, id DESC);
      CREATE INDEX IF NOT EXISTS longtu_aliases_sha256
        ON longtu_aliases(sha256);
    `);
    return this.database;
  }

  async load() {
    this.ensureOpen();
    await this.loadSeedAliases();
    return this.getStats();
  }

  async loadSeedAliases() {
    if (!this.seedAliasesFilePath) return 0;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.seedAliasesFilePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw new Error(`读取龙图文字别名失败：${error.message}`);
    }
    const entries = Array.isArray(parsed) ? parsed : parsed.aliases;
    if (!Array.isArray(entries)) return 0;
    const database = this.ensureOpen();
    const insert = database.prepare(`
      INSERT OR IGNORE INTO longtu_aliases(
        alias, sha256, source, created_by, created_at, updated_at,
        deleted_at, deleted_by
      ) VALUES (?, ?, 'ocr', 'system:ocr', ?, ?, NULL, NULL)
    `);
    const currentTime = this.now();
    let imported = 0;
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of entries) {
        const alias = normalizeLongtuAlias(entry?.alias);
        const sha256 = String(entry?.sha256 ?? '').trim().toLowerCase();
        if (!alias || !/^[a-f0-9]{64}$/.test(sha256)) continue;
        imported += Number(insert.run(alias, sha256, currentTime, currentTime).changes > 0);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return imported;
  }

  async ensureCandidateMetadata(candidate) {
    const database = this.ensureOpen();
    if (candidate.sha256 && candidate.perceptualHashes?.length > 0) {
      return candidate;
    }
    const buffer = candidate.buffer ?? await readFile(candidate.path);
    const sha256 = candidate.sha256
      ?? createHash('sha256').update(buffer).digest('hex');
    const cached = database.prepare(`
      SELECT perceptual_hashes
      FROM longtu_catalog_features
      WHERE sha256 = ?
    `).get(sha256);
    let perceptualHashes = parseHashes(cached?.perceptual_hashes);
    if (perceptualHashes.length === 0) {
      perceptualHashes = await extractPerceptualHashes(buffer);
      database.prepare(`
        INSERT INTO longtu_catalog_features(
          sha256, perceptual_hashes, feature_views, updated_at
        ) VALUES (?, ?, NULL, ?)
        ON CONFLICT(sha256) DO UPDATE SET
          perceptual_hashes = excluded.perceptual_hashes,
          updated_at = excluded.updated_at
      `).run(sha256, JSON.stringify(perceptualHashes), this.now());
    }
    candidate.sha256 = sha256;
    candidate.perceptualHashes = perceptualHashes;
    return candidate;
  }

  async getReferenceFeatures(candidate) {
    const withMetadata = await this.ensureCandidateMetadata(candidate);
    if (this.referenceFeatures.has(withMetadata.sha256)) {
      return this.referenceFeatures.get(withMetadata.sha256);
    }
    const database = this.ensureOpen();
    const cached = database.prepare(`
      SELECT feature_views
      FROM longtu_catalog_features
      WHERE sha256 = ?
    `).get(withMetadata.sha256);
    let featureViews = deserializeFeatureViews(cached?.feature_views);
    if (!featureViews?.length) {
      const buffer = withMetadata.buffer ?? await readFile(withMetadata.path);
      featureViews = await extractImageFeatures(buffer);
      database.prepare(`
        INSERT INTO longtu_catalog_features(
          sha256, perceptual_hashes, feature_views, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(sha256) DO UPDATE SET
          perceptual_hashes = excluded.perceptual_hashes,
          feature_views = excluded.feature_views,
          updated_at = excluded.updated_at
      `).run(
        withMetadata.sha256,
        JSON.stringify(withMetadata.perceptualHashes),
        JSON.stringify(serializeFeatureViews(featureViews)),
        this.now(),
      );
    }
    this.referenceFeatures.set(withMetadata.sha256, featureViews);
    return featureViews;
  }

  getDynamicCandidates() {
    return this.ensureOpen().prepare(`
      SELECT sha256, short_id, filename, extension, perceptual_hashes
      FROM longtu_assets
      WHERE deleted_at IS NULL
      ORDER BY added_at ASC
    `).all().map((row) => ({
      path: path.join(this.assetsDirectory, row.filename),
      sha256: row.sha256,
      shortId: row.short_id,
      extension: row.extension,
      perceptualHashes: parseHashes(row.perceptual_hashes),
      dynamic: true,
      score: 0,
    }));
  }

  isBlocked(sha256) {
    if (!sha256) return false;
    return Boolean(this.ensureOpen().prepare(
      'SELECT 1 FROM longtu_blocklist WHERE sha256 = ?',
    ).get(sha256));
  }

  async reviewAndAdd(buffer, options = {}) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('缺少图片数据');
    if (buffer.length < 5 || buffer.length > MAX_IMAGE_BYTES) {
      throw new Error('图片大小必须在 5 字节到 10MB 之间');
    }
    const extension = detectImageExtension(buffer);
    if (!extension) throw new Error('只支持 JPG、PNG 或 GIF 图片');

    const database = this.ensureOpen();
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const shortId = shortIdForHash(sha256);
    const existingDynamic = database.prepare(`
      SELECT short_id, deleted_at FROM longtu_assets WHERE sha256 = ?
    `).get(sha256);
    if (existingDynamic) {
      throw new Error(existingDynamic.deleted_at
        ? `这张图曾加入后被删除（${existingDynamic.short_id}），请先撤销删除`
        : `这张图已经在图库中（${existingDynamic.short_id}）`);
    }

    const references = options.referenceCandidates ?? [];
    for (const candidate of references) {
      const metadata = await this.ensureCandidateMetadata(candidate);
      if (metadata.sha256 === sha256) {
        throw new Error(`这张图已经在图库中（${shortId}）`);
      }
    }

    const perceptualHashes = await extractPerceptualHashes(buffer);
    let minimumHashDistance = Number.POSITIVE_INFINITY;
    if (!options.force) {
      for (const candidate of references) {
        const metadata = await this.ensureCandidateMetadata(candidate);
        minimumHashDistance = Math.min(
          minimumHashDistance,
          minimumPerceptualHashDistance(perceptualHashes, metadata.perceptualHashes),
        );
      }
    }
    if (minimumHashDistance <= NEAR_DUPLICATE_HASH_DISTANCE && !options.force) {
      throw new Error('这张图与图库现有图片几乎相同；如确认要保留，请使用“强制添加这张龙图”');
    }

    const candidateFeatures = await extractImageFeatures(buffer);
    const referenceFeatureSets = [];
    if (!options.force) {
      for (const candidate of references) {
        referenceFeatureSets.push(await this.getReferenceFeatures(candidate));
      }
    }
    const featureDistance = referenceFeatureSets.length > 0
      ? minimumFeatureDistance(candidateFeatures, referenceFeatureSets)
      : 0;
    if (!options.force && featureDistance > AUTO_ACCEPT_DISTANCE) {
      if (featureDistance <= AMBIGUOUS_DISTANCE) {
        throw new Error(
          `特征复核结果不够确定（距离 ${featureDistance.toFixed(3)}）；确认是龙图可使用“强制添加这张龙图”`,
        );
      }
      throw new Error(
        `特征复核未通过（距离 ${featureDistance.toFixed(3)}），未加入图库；管理员仍可强制添加`,
      );
    }

    const filename = `${sha256}${extension}`;
    await writeFile(path.join(this.assetsDirectory, filename), buffer, { flag: 'wx' });
    const actor = normalizeActor(options.actor);
    const currentTime = this.now();
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`
        INSERT INTO longtu_assets(
          sha256, short_id, filename, extension, perceptual_hashes,
          feature_views, added_by, added_at, deleted_at, deleted_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        sha256,
        shortId,
        filename,
        extension,
        JSON.stringify(perceptualHashes),
        JSON.stringify(serializeFeatureViews(candidateFeatures)),
        actor,
        currentTime,
      );
      database.prepare(`
        INSERT INTO longtu_catalog_features(
          sha256, perceptual_hashes, feature_views, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(sha256) DO UPDATE SET
          perceptual_hashes = excluded.perceptual_hashes,
          feature_views = excluded.feature_views,
          updated_at = excluded.updated_at
      `).run(
        sha256,
        JSON.stringify(perceptualHashes),
        JSON.stringify(serializeFeatureViews(candidateFeatures)),
        currentTime,
      );
      database.prepare('DELETE FROM longtu_blocklist WHERE sha256 = ?').run(sha256);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    this.referenceFeatures.set(sha256, candidateFeatures);
    return {
      sha256,
      shortId,
      extension,
      featureDistance,
      forced: Boolean(options.force),
    };
  }

  resolveShaByShortId(shortId) {
    const normalized = String(shortId ?? '').trim().toUpperCase();
    if (!/^LT-[A-F0-9]{8}$/.test(normalized)) return '';
    const dynamic = this.ensureOpen().prepare(
      'SELECT sha256 FROM longtu_assets WHERE short_id = ?',
    ).get(normalized);
    return dynamic?.sha256 ?? normalized.slice(3).toLowerCase();
  }

  async resolveShaByBuffer(buffer, referenceCandidates = []) {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const dynamic = this.ensureOpen().prepare(
      'SELECT sha256 FROM longtu_assets WHERE sha256 = ?',
    ).get(sha256);
    if (dynamic) return sha256;
    const exactReference = referenceCandidates.find((candidate) => candidate.sha256 === sha256);
    return exactReference ? sha256 : '';
  }

  bindAlias(alias, sha256, options = {}) {
    const normalizedAlias = normalizeLongtuAlias(alias);
    const normalizedSha = String(sha256 ?? '').trim().toLowerCase();
    if (!normalizedAlias) throw new Error('别名需要是 2～32 个有效字符');
    if (!/^[a-f0-9]{64}$/.test(normalizedSha)) throw new Error('没有找到要绑定的龙图');
    const actor = normalizeActor(options.actor);
    const currentTime = this.now();
    const previous = this.ensureOpen().prepare(`
      SELECT sha256 FROM longtu_aliases
      WHERE alias = ? AND deleted_at IS NULL
    `).get(normalizedAlias);
    this.ensureOpen().prepare(`
      INSERT INTO longtu_aliases(
        alias, sha256, source, created_by, created_at, updated_at,
        deleted_at, deleted_by
      ) VALUES (?, ?, 'manual', ?, ?, ?, NULL, NULL)
      ON CONFLICT(alias) DO UPDATE SET
        sha256 = excluded.sha256,
        source = 'manual',
        created_by = excluded.created_by,
        updated_at = excluded.updated_at,
        deleted_at = NULL,
        deleted_by = NULL
    `).run(normalizedAlias, normalizedSha, actor, currentTime, currentTime);
    return {
      alias: normalizedAlias,
      sha256: normalizedSha,
      replaced: Boolean(previous && previous.sha256 !== normalizedSha),
    };
  }

  unbindAlias(alias, options = {}) {
    const normalizedAlias = normalizeLongtuAlias(alias);
    if (!normalizedAlias) throw new Error('没有找到要取消的别名');
    const actor = normalizeActor(options.actor);
    const currentTime = this.now();
    const result = this.ensureOpen().prepare(`
      UPDATE longtu_aliases
      SET deleted_at = ?, deleted_by = ?, updated_at = ?
      WHERE alias = ? AND deleted_at IS NULL
    `).run(currentTime, actor, currentTime, normalizedAlias);
    if (result.changes === 0) throw new Error(`没有找到别名“${normalizedAlias}”`);
    return { alias: normalizedAlias };
  }

  listAliases(options = {}) {
    const requestedLimit = Number.parseInt(options.limit ?? '1000', 10);
    const limit = Number.isInteger(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 5000))
      : 1000;
    return this.ensureOpen().prepare(`
      SELECT alias, sha256, source, updated_at AS updatedAt
      FROM longtu_aliases
      WHERE deleted_at IS NULL
      ORDER BY LENGTH(alias) DESC, alias ASC
      LIMIT ?
    `).all(limit);
  }

  resolveAlias(alias) {
    const normalizedAlias = normalizeLongtuAlias(alias);
    if (!normalizedAlias) return null;
    return this.ensureOpen().prepare(`
      SELECT alias, sha256, source
      FROM longtu_aliases
      WHERE alias = ? AND deleted_at IS NULL
    `).get(normalizedAlias) ?? null;
  }

  deleteBySha(sha256, options = {}) {
    const normalized = String(sha256 ?? '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
      throw new Error('没有找到要删除的龙图');
    }
    const database = this.ensureOpen();
    const actor = normalizeActor(options.actor);
    const currentTime = this.now();
    const dynamic = database.prepare(`
      SELECT short_id, deleted_at FROM longtu_assets WHERE sha256 = ?
    `).get(normalized);
    if (dynamic?.deleted_at) throw new Error(`这张图已经删除（${dynamic.short_id}）`);
    const shortId = dynamic?.short_id ?? shortIdForHash(normalized);

    database.exec('BEGIN IMMEDIATE');
    try {
      if (dynamic) {
        database.prepare(`
          UPDATE longtu_assets SET deleted_at = ?, deleted_by = ? WHERE sha256 = ?
        `).run(currentTime, actor, normalized);
      }
      database.prepare(`
        INSERT INTO longtu_blocklist(sha256, short_id, deleted_by, deleted_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(sha256) DO UPDATE SET
          deleted_by = excluded.deleted_by,
          deleted_at = excluded.deleted_at
      `).run(normalized, shortId, actor, currentTime);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return { sha256: normalized, shortId, dynamic: Boolean(dynamic) };
  }

  undoDelete(options = {}) {
    const database = this.ensureOpen();
    const actor = normalizeActor(options.actor);
    const row = database.prepare(`
      SELECT sha256, short_id
      FROM longtu_blocklist
      WHERE deleted_by = ?
      ORDER BY deleted_at DESC
      LIMIT 1
    `).get(actor);
    if (!row) throw new Error('没有可撤销的删除操作');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM longtu_blocklist WHERE sha256 = ?').run(row.sha256);
      database.prepare(`
        UPDATE longtu_assets
        SET deleted_at = NULL, deleted_by = NULL
        WHERE sha256 = ?
      `).run(row.sha256);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return { sha256: row.sha256, shortId: row.short_id };
  }

  buildSceneAssignments(candidates) {
    const representatives = [];
    const sceneBySha = new Map();
    for (const candidate of candidates) {
      let scene = representatives.find((representative) => (
        minimumPerceptualHashDistance(
          candidate.perceptualHashes,
          representative.perceptualHashes,
        ) <= SCENE_HASH_DISTANCE
      ));
      if (!scene) {
        scene = {
          id: `scene-${candidate.sha256.slice(0, 12)}`,
          perceptualHashes: candidate.perceptualHashes,
        };
        representatives.push(scene);
      }
      sceneBySha.set(candidate.sha256, scene.id);
    }
    return sceneBySha;
  }

  async pickCandidate(inputCandidates, options = {}) {
    const metadataCandidates = [];
    for (const candidate of inputCandidates) {
      const withMetadata = await this.ensureCandidateMetadata(candidate);
      if (!this.isBlocked(withMetadata.sha256)) metadataCandidates.push(withMetadata);
    }
    if (metadataCandidates.length === 0) throw new Error('龙图候选集中没有可用图片');

    const scope = normalizeScope(options.scope);
    const poolKey = createHash('sha256')
      .update(metadataCandidates.map((candidate) => candidate.sha256).sort().join(','))
      .digest('hex')
      .slice(0, 16);
    const database = this.ensureOpen();
    let state = database.prepare(`
      SELECT cycle FROM longtu_selection_state WHERE scope = ? AND pool_key = ?
    `).get(scope, poolKey);
    if (!state) {
      database.prepare(`
        INSERT INTO longtu_selection_state(scope, pool_key, cycle) VALUES (?, ?, 1)
      `).run(scope, poolKey);
      state = { cycle: 1 };
    }

    let cycle = Number(state.cycle);
    const selectedHashes = new Set(database.prepare(`
      SELECT sha256 FROM longtu_selections
      WHERE scope = ? AND pool_key = ? AND cycle = ?
    `).all(scope, poolKey, cycle).map((row) => row.sha256));
    let available = metadataCandidates.filter(
      (candidate) => !selectedHashes.has(candidate.sha256),
    );
    if (available.length === 0) {
      cycle += 1;
      database.prepare(`
        UPDATE longtu_selection_state SET cycle = ? WHERE scope = ? AND pool_key = ?
      `).run(cycle, scope, poolKey);
      available = metadataCandidates;
    }

    const sceneBySha = this.buildSceneAssignments(metadataCandidates);
    const recentScenes = new Set(database.prepare(`
      SELECT scene_id FROM longtu_selections
      WHERE scope = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(scope, RECENT_SCENE_WINDOW).map((row) => row.scene_id));
    let sceneCandidates = available.filter(
      (candidate) => !recentScenes.has(sceneBySha.get(candidate.sha256)),
    );
    if (sceneCandidates.length === 0) sceneCandidates = available;

    const grouped = new Map();
    for (const candidate of sceneCandidates) {
      const sceneId = sceneBySha.get(candidate.sha256);
      const group = grouped.get(sceneId) ?? [];
      group.push(candidate);
      grouped.set(sceneId, group);
    }
    const sceneId = shufflePick([...grouped.keys()]);
    const candidate = shufflePick(grouped.get(sceneId));
    database.prepare(`
      INSERT INTO longtu_selections(
        scope, pool_key, cycle, sha256, scene_id, selected_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(scope, poolKey, cycle, candidate.sha256, sceneId, this.now());
    database.prepare(`
      DELETE FROM longtu_selections
      WHERE id IN (
        SELECT id FROM longtu_selections
        WHERE scope = ?
        ORDER BY id DESC
        LIMIT -1 OFFSET 3000
      )
    `).run(scope);
    return candidate;
  }

  async recordDirectSelection(inputCandidate, options = {}) {
    const candidate = await this.ensureCandidateMetadata(inputCandidate);
    if (this.isBlocked(candidate.sha256)) throw new Error('这张龙图已被删除或屏蔽');
    const scope = normalizeScope(options.scope);
    const database = this.ensureOpen();
    database.prepare(`
      INSERT INTO longtu_selections(
        scope, pool_key, cycle, sha256, scene_id, selected_at
      ) VALUES (?, 'direct-alias', 1, ?, ?, ?)
    `).run(scope, candidate.sha256, `scene-${candidate.sha256.slice(0, 12)}`, this.now());
    database.prepare(`
      DELETE FROM longtu_selections
      WHERE id IN (
        SELECT id FROM longtu_selections
        WHERE scope = ?
        ORDER BY id DESC
        LIMIT -1 OFFSET 3000
      )
    `).run(scope);
    return candidate;
  }

  getLastSelection(scope) {
    return this.ensureOpen().prepare(`
      SELECT sha256, scene_id, selected_at
      FROM longtu_selections
      WHERE scope = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(normalizeScope(scope)) ?? null;
  }

  getStats() {
    const database = this.ensureOpen();
    return {
      dynamicActive: Number(database.prepare(`
        SELECT COUNT(*) AS count FROM longtu_assets WHERE deleted_at IS NULL
      `).get().count),
      dynamicDeleted: Number(database.prepare(`
        SELECT COUNT(*) AS count FROM longtu_assets WHERE deleted_at IS NOT NULL
      `).get().count),
      blocked: Number(database.prepare(`
        SELECT COUNT(*) AS count FROM longtu_blocklist
      `).get().count),
      selections: Number(database.prepare(`
        SELECT COUNT(*) AS count FROM longtu_selections
      `).get().count),
      aliases: Number(database.prepare(`
        SELECT COUNT(*) AS count FROM longtu_aliases WHERE deleted_at IS NULL
      `).get().count),
      manualAliases: Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM longtu_aliases
        WHERE deleted_at IS NULL AND source = 'manual'
      `).get().count),
    };
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

export const LONGTU_REVIEW_THRESHOLDS = Object.freeze({
  autoAcceptDistance: AUTO_ACCEPT_DISTANCE,
  ambiguousDistance: AMBIGUOUS_DISTANCE,
  nearDuplicateHashDistance: NEAR_DUPLICATE_HASH_DISTANCE,
  sceneHashDistance: SCENE_HASH_DISTANCE,
  recentSceneWindow: RECENT_SCENE_WINDOW,
});
