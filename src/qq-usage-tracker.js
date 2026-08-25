import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;
const DEFAULT_RETENTION_MS = 35 * 24 * HOUR_MS;
const DEFAULT_ACTIVITY_LOOKBACK_DAYS = 7;
const DEFAULT_ACTIVITY_PROFILE_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_ACTIVITY_MESSAGE_THRESHOLDS = [20, 60, 150, 400];
const DEFAULT_ACTIVITY_USER_THRESHOLDS = [3, 8, 20, 40];
const DEFAULT_ACTIVITY_LIMIT_PERCENTAGES = [60, 75, 85, 95, 100];
const ACTIVITY_TIER_NAMES = ['quiet', 'light', 'normal', 'active', 'hot'];
const DEFAULT_LARGE_GROUP_SECONDARY_REVIEW_PERCENT = 20;
const SECONDARY_REVIEW_SOURCES = new Map([
  ['conversation-reply-review', 'conversation-reply'],
  ['active-reply-review', 'active-reply'],
]);
const LOCALLY_REPAIRABLE_REVIEW_ISSUES = new Set([
  'missing-venomous-bite',
]);
const PRICE_UNIT_TOKENS = 1_000_000;
const DEEPSEEK_PRICING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const DEEPSEEK_PRICING_CHECKED_AT = '2026-08-25';
const DEEPSEEK_PRICES_CNY = new Map([
  ['deepseek-v4-flash', {
    offPeak: { cachedInput: 0.05, uncachedInput: 1.5, output: 4.5 },
    peak: { cachedInput: 0.10, uncachedInput: 3.0, output: 9.0 },
  }],
  ['deepseek-v4-pro', {
    offPeak: { cachedInput: 0.15, uncachedInput: 4.5, output: 13.5 },
    peak: { cachedInput: 0.30, uncachedInput: 9.0, output: 27.0 },
  }],
  ['deepseek-v4-flash-vision-exp', {
    offPeak: { cachedInput: 0.05, uncachedInput: 1.5, output: 4.5 },
    peak: { cachedInput: 0.10, uncachedInput: 3.0, output: 9.0 },
  }],
]);

export class QqUsageLimitError extends Error {
  constructor(groupId, limit, metric = 'llm-calls') {
    const description = metric === 'llm-tokens'
      ? `今日大模型 Token 已达到上限 ${limit}`
      : (metric === 'llm-passive-tokens'
        ? `今日后台/主动插话 Token 已达到预留线 ${limit}`
        : (metric === 'search-calls'
          ? `今日联网搜索已达到上限 ${limit}`
          : `本小时大模型调用已达到上限 ${limit}`));
    super(`群 ${groupId} ${description}`);
    this.name = 'QqUsageLimitError';
    this.groupId = groupId;
    this.limit = limit;
    this.metric = metric;
  }
}

function positiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function usageNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function percentage(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
    ? parsed
    : fallback;
}

function ascendingIntegerList(value, fallback, expectedLength) {
  const source = Array.isArray(value) ? value : [];
  if (source.length !== expectedLength) return [...fallback];
  const normalized = source.map((entry) => positiveInteger(entry, -1));
  if (normalized.some((entry) => entry < 0)) return [...fallback];
  if (normalized.some((entry, index) => index > 0 && entry <= normalized[index - 1])) {
    return [...fallback];
  }
  return normalized;
}

function percentageList(value, fallback, expectedLength) {
  const normalized = ascendingIntegerList(value, fallback, expectedLength);
  if (normalized.some((entry) => entry < 1 || entry > 100)) return [...fallback];
  return normalized;
}

function normalizeContext(context = {}) {
  const groupId = String(context.groupId ?? '').trim();
  return {
    groupId,
    userId: String(context.userId ?? '').trim(),
    messageType: context.messageType === 'private' ? 'private' : 'group',
    largeGroup: context.largeGroup === true,
    source: String(context.source ?? '').trim() || 'unknown',
  };
}

function startOfShanghaiDay(timestamp) {
  return Math.floor((timestamp + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS
    - SHANGHAI_OFFSET_MS;
}

function isDeepSeekPeakTime(timestamp) {
  const shanghai = new Date(timestamp + SHANGHAI_OFFSET_MS);
  const weekday = shanghai.getUTCDay();
  if (weekday < 1 || weekday > 5) return false;
  const minutes = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
  return (minutes >= 9 * 60 && minutes < 12 * 60)
    || (minutes >= 14 * 60 && minutes < 18 * 60);
}

function emptyCostSummary() {
  return {
    estimatedCostCny: 0,
    cachedInputCostCny: 0,
    uncachedInputCostCny: 0,
    outputCostCny: 0,
    peakCostCny: 0,
    offPeakCostCny: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    unpricedTokens: 0,
    models: new Set(),
  };
}

function addCost(target, field, value) {
  target[field] += Number(value || 0);
}

function serializeCostSummary(summary) {
  const money = (value) => Math.round(Number(value || 0) * 1_000_000_000) / 1_000_000_000;
  return {
    estimatedCostCny: money(summary.estimatedCostCny),
    cachedInputCostCny: money(summary.cachedInputCostCny),
    uncachedInputCostCny: money(summary.uncachedInputCostCny),
    outputCostCny: money(summary.outputCostCny),
    peakCostCny: money(summary.peakCostCny),
    offPeakCostCny: money(summary.offPeakCostCny),
    pricedCalls: summary.pricedCalls,
    unpricedCalls: summary.unpricedCalls,
    unpricedTokens: summary.unpricedTokens,
    models: [...summary.models].sort(),
  };
}

function calculateDeepSeekCosts(rows) {
  const total = emptyCostSummary();
  const byGroup = new Map();
  for (const row of rows) {
    const groupId = String(row.groupId ?? '').trim();
    const group = byGroup.get(groupId) ?? emptyCostSummary();
    byGroup.set(groupId, group);
    const model = String(row.model ?? '').trim();
    const inputTokens = usageNumber(row.inputTokens);
    const cachedInputTokens = Math.min(
      inputTokens,
      usageNumber(row.cachedInputTokens),
    );
    const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
    const outputTokens = usageNumber(row.outputTokens);
    const totalTokens = inputTokens + outputTokens;
    const modelPrices = DEEPSEEK_PRICES_CNY.get(model);
    if (!modelPrices) {
      for (const target of [total, group]) {
        target.unpricedCalls += 1;
        target.unpricedTokens += totalTokens;
        if (model) target.models.add(model);
      }
      continue;
    }
    const peak = isDeepSeekPeakTime(Number(row.createdAt));
    const prices = peak ? modelPrices.peak : modelPrices.offPeak;
    const cachedInputCostCny = cachedInputTokens / PRICE_UNIT_TOKENS
      * prices.cachedInput;
    const uncachedInputCostCny = uncachedInputTokens / PRICE_UNIT_TOKENS
      * prices.uncachedInput;
    const outputCostCny = outputTokens / PRICE_UNIT_TOKENS * prices.output;
    const estimatedCostCny = cachedInputCostCny
      + uncachedInputCostCny
      + outputCostCny;
    for (const target of [total, group]) {
      target.models.add(model);
      target.pricedCalls += 1;
      addCost(target, 'estimatedCostCny', estimatedCostCny);
      addCost(target, 'cachedInputCostCny', cachedInputCostCny);
      addCost(target, 'uncachedInputCostCny', uncachedInputCostCny);
      addCost(target, 'outputCostCny', outputCostCny);
      addCost(target, peak ? 'peakCostCny' : 'offPeakCostCny', estimatedCostCny);
    }
  }
  return {
    total: serializeCostSummary(total),
    byGroup: new Map([...byGroup].map(([groupId, summary]) => (
      [groupId, serializeCostSummary(summary)]
    ))),
  };
}

export class UsageTrackedChatClient {
  constructor(client, tracker) {
    this.client = client;
    this.tracker = tracker;
  }

  get isConfigured() {
    return this.client.isConfigured;
  }

  get model() {
    return this.client.model;
  }

  async complete(history, userContent, options = {}) {
    let observedUsage = null;
    let succeeded = false;
    const reservation = this.tracker.startLlmCall({
      source: options.usageSource,
      model: options.model ?? this.client.model,
    });
    try {
      const originalOnUsage = options.onUsage;
      const result = await this.client.complete(history, userContent, {
        ...options,
        onUsage: (info) => {
          observedUsage = info?.usage ?? info ?? null;
          if (typeof originalOnUsage === 'function') originalOnUsage(info);
        },
      });
      succeeded = true;
      return result;
    } finally {
      this.tracker.finishLlmCall(reservation, {
        usage: observedUsage,
        succeeded,
      });
    }
  }
}

export class UsageTrackedWebSearch {
  constructor(search, tracker) {
    this.searchClient = search;
    this.tracker = tracker;
  }

  get enabled() {
    return this.searchClient.enabled;
  }

  get provider() {
    return this.searchClient.provider;
  }

  async search(content, options = {}) {
    let result;
    let upstreamRequests = 0;
    const reservations = [];
    const originalOnBeforeUpstreamRequest = options.onBeforeUpstreamRequest;
    const originalOnUpstreamRequest = options.onUpstreamRequest;
    result = await this.searchClient.search(content, {
      ...options,
      onBeforeUpstreamRequest: (info = {}) => {
        reservations.push(this.tracker.startSearchCall({
          source: options.usageSource,
        }));
        if (typeof originalOnBeforeUpstreamRequest === 'function') {
          originalOnBeforeUpstreamRequest(info);
        }
      },
      onUpstreamRequest: (info = {}) => {
        upstreamRequests += 1;
        this.tracker.finishSearchCall(reservations.shift(), {
          resultCount: info.resultCount,
          succeeded: info.succeeded,
        });
        if (typeof originalOnUpstreamRequest === 'function') {
          originalOnUpstreamRequest(info);
        }
      },
    });
    if (upstreamRequests === 0 && result?.fromCache) {
      this.tracker.recordSearchCacheHit({
        source: options.usageSource,
        resultCount: result?.resultCount,
      });
    }
    return result;
  }
}

export class QqUsageTracker {
  constructor(options = {}) {
    this.databaseFilePath = String(options.databaseFilePath ?? '').trim();
    this.maxGroupLlmCallsPerHour = positiveInteger(
      options.maxGroupLlmCallsPerHour,
      0,
    );
    this.maxLargeGroupLlmCallsPerHour = positiveInteger(
      options.maxLargeGroupLlmCallsPerHour,
      this.maxGroupLlmCallsPerHour,
    );
    this.maxGroupLlmTokensPerDay = positiveInteger(
      options.maxGroupLlmTokensPerDay,
      0,
    );
    this.maxLargeGroupLlmTokensPerDay = positiveInteger(
      options.maxLargeGroupLlmTokensPerDay,
      this.maxGroupLlmTokensPerDay,
    );
    this.groupLlmLimits = options.groupLlmLimits instanceof Map
      ? new Map(options.groupLlmLimits)
      : new Map();
    this.groupLlmTokenLimits = options.groupLlmTokenLimits instanceof Map
      ? new Map(options.groupLlmTokenLimits)
      : new Map();
    this.cachedTokenWeightPercent = percentage(
      options.cachedTokenWeightPercent,
      10,
    );
    this.passiveTokenBudgetPercent = percentage(
      options.passiveTokenBudgetPercent,
      70,
    );
    this.largeGroupSecondaryReviewPercent = percentage(
      options.largeGroupSecondaryReviewPercent,
      DEFAULT_LARGE_GROUP_SECONDARY_REVIEW_PERCENT,
    );
    this.adaptiveLimitsEnabled = options.adaptiveLimitsEnabled !== false;
    this.activityLookbackDays = positiveInteger(
      options.activityLookbackDays,
      DEFAULT_ACTIVITY_LOOKBACK_DAYS,
    ) || DEFAULT_ACTIVITY_LOOKBACK_DAYS;
    this.activityMessageThresholds = ascendingIntegerList(
      options.activityMessageThresholds,
      DEFAULT_ACTIVITY_MESSAGE_THRESHOLDS,
      ACTIVITY_TIER_NAMES.length - 1,
    );
    this.activityUserThresholds = ascendingIntegerList(
      options.activityUserThresholds,
      DEFAULT_ACTIVITY_USER_THRESHOLDS,
      ACTIVITY_TIER_NAMES.length - 1,
    );
    this.activityLimitPercentages = percentageList(
      options.activityLimitPercentages,
      DEFAULT_ACTIVITY_LIMIT_PERCENTAGES,
      ACTIVITY_TIER_NAMES.length,
    );
    this.activityProfileCacheMs = positiveInteger(
      options.activityProfileCacheMs,
      DEFAULT_ACTIVITY_PROFILE_CACHE_MS,
    );
    this.maxGroupSearchCallsPerDay = positiveInteger(
      options.maxGroupSearchCallsPerDay,
      0,
    );
    this.maxLargeGroupSearchCallsPerDay = positiveInteger(
      options.maxLargeGroupSearchCallsPerDay,
      this.maxGroupSearchCallsPerDay,
    );
    this.groupSearchLimits = options.groupSearchLimits instanceof Map
      ? new Map(options.groupSearchLimits)
      : new Map();
    this.retentionMs = positiveInteger(options.retentionMs, DEFAULT_RETENTION_MS)
      || DEFAULT_RETENTION_MS;
    this.now = options.now ?? Date.now;
    this.database = null;
    this.contextStorage = new AsyncLocalStorage();
    this.activityProfileCache = new Map();
  }

  ensureOpen() {
    if (this.database) return this.database;
    if (!this.databaseFilePath) {
      throw new Error('QQ 用量数据库路径不能为空');
    }
    mkdirSync(path.dirname(this.databaseFilePath), { recursive: true });
    this.database = new DatabaseSync(this.databaseFilePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS qq_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        group_id TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        message_type TEXT NOT NULL DEFAULT 'group',
        kind TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        allowed INTEGER NOT NULL DEFAULT 1,
        succeeded INTEGER NOT NULL DEFAULT 1,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        search_results INTEGER NOT NULL DEFAULT 0,
        search_cache INTEGER NOT NULL DEFAULT 0,
        large_group INTEGER NOT NULL DEFAULT 0,
        limit_reason TEXT NOT NULL DEFAULT '',
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        quota_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS qq_usage_events_group_created
        ON qq_usage_events(group_id, created_at);
      CREATE INDEX IF NOT EXISTS qq_usage_events_kind_created
        ON qq_usage_events(kind, created_at);
    `);
    const columns = new Set(this.database.prepare(
      'PRAGMA table_info(qq_usage_events)',
    ).all().map((column) => column.name));
    if (!columns.has('large_group')) {
      this.database.exec(
        'ALTER TABLE qq_usage_events ADD COLUMN large_group INTEGER NOT NULL DEFAULT 0',
      );
    }
    if (!columns.has('limit_reason')) {
      this.database.exec(
        "ALTER TABLE qq_usage_events ADD COLUMN limit_reason TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!columns.has('cached_input_tokens')) {
      this.database.exec(
        'ALTER TABLE qq_usage_events ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0',
      );
    }
    if (!columns.has('quota_tokens')) {
      this.database.exec(
        'ALTER TABLE qq_usage_events ADD COLUMN quota_tokens INTEGER NOT NULL DEFAULT 0',
      );
    }
    return this.database;
  }

  currentContext() {
    return this.contextStorage.getStore() ?? normalizeContext();
  }

  runWithContext(context, task) {
    return this.contextStorage.run(normalizeContext(context), task);
  }

  wrapChatClient(client) {
    return new UsageTrackedChatClient(client, this);
  }

  wrapWebSearch(search) {
    return new UsageTrackedWebSearch(search, this);
  }

  prune(now = this.now()) {
    this.ensureOpen().prepare(
      'DELETE FROM qq_usage_events WHERE created_at < ?',
    ).run(now - this.retentionMs);
  }

  recordRequest(context = {}) {
    const normalized = normalizeContext({
      ...this.currentContext(),
      ...context,
    });
    this.ensureOpen().prepare(`
      INSERT INTO qq_usage_events(
        created_at, group_id, user_id, message_type, kind, source, large_group
      ) VALUES (?, ?, ?, ?, 'request', ?, ?)
    `).run(
      this.now(),
      normalized.groupId,
      normalized.userId,
      normalized.messageType,
      normalized.source,
      normalized.largeGroup ? 1 : 0,
    );
  }

  getGroupActivityProfile(groupId, now = this.now()) {
    const normalizedGroupId = String(groupId ?? '').trim();
    if (!normalizedGroupId || !this.adaptiveLimitsEnabled) {
      return {
        tier: this.adaptiveLimitsEnabled ? 'quiet' : 'fixed',
        limitPercent: 100,
        messagesPerDay: 0,
        activeUsersPerDay: 0,
        lookbackDays: this.activityLookbackDays,
      };
    }
    const cached = this.activityProfileCache.get(normalizedGroupId);
    if (cached && this.activityProfileCacheMs > 0
      && now - cached.cachedAt < this.activityProfileCacheMs) {
      return cached.profile;
    }
    const startAt = now - this.activityLookbackDays * DAY_MS;
    const database = this.ensureOpen();
    const activity = database.prepare(`
      SELECT COUNT(*) AS requests, MIN(created_at) AS firstAt
      FROM qq_usage_events
      WHERE kind = 'request' AND message_type = 'group'
        AND group_id = ? AND created_at >= ? AND created_at < ?
    `).get(normalizedGroupId, startAt, now + 1);
    const dailyUsers = database.prepare(`
      SELECT COUNT(*) AS entries
      FROM (
        SELECT CAST((created_at + ?) / ? AS INTEGER) AS dayKey, user_id
        FROM qq_usage_events
        WHERE kind = 'request' AND message_type = 'group'
          AND group_id = ? AND user_id <> ''
          AND created_at >= ? AND created_at < ?
        GROUP BY dayKey, user_id
      )
    `).get(
      SHANGHAI_OFFSET_MS,
      DAY_MS,
      normalizedGroupId,
      startAt,
      now + 1,
    );
    const requests = Number(activity.requests || 0);
    const firstAt = Number(activity.firstAt || now);
    const observedDays = Math.min(
      this.activityLookbackDays,
      Math.max(1, Math.ceil((now - Math.max(startAt, firstAt) + 1) / DAY_MS)),
    );
    const messagesPerDay = requests / observedDays;
    const activeUsersPerDay = Number(dailyUsers.entries || 0) / observedDays;
    let tierIndex = 0;
    for (let index = 0; index < this.activityMessageThresholds.length; index += 1) {
      if (messagesPerDay >= this.activityMessageThresholds[index]
        || activeUsersPerDay >= this.activityUserThresholds[index]) {
        tierIndex = index + 1;
      }
    }
    const profile = {
      tier: ACTIVITY_TIER_NAMES[tierIndex],
      limitPercent: this.activityLimitPercentages[tierIndex],
      messagesPerDay: Math.round(messagesPerDay * 10) / 10,
      activeUsersPerDay: Math.round(activeUsersPerDay * 10) / 10,
      lookbackDays: this.activityLookbackDays,
    };
    this.activityProfileCache.set(normalizedGroupId, {
      cachedAt: now,
      profile,
    });
    return profile;
  }

  adaptiveGroupLimit(groupId, hardLimit) {
    if (hardLimit <= 0) return 0;
    const profile = this.getGroupActivityProfile(groupId);
    return Math.max(1, Math.ceil(hardLimit * profile.limitPercent / 100));
  }

  groupHardLlmCallLimit(context) {
    return positiveInteger(
      this.groupLlmLimits.get(context.groupId),
      context.largeGroup
        ? this.maxLargeGroupLlmCallsPerHour
        : this.maxGroupLlmCallsPerHour,
    );
  }

  groupLlmCallLimit(context) {
    return this.adaptiveGroupLimit(
      context.groupId,
      this.groupHardLlmCallLimit(context),
    );
  }

  groupHardLlmTokenLimit(context) {
    return positiveInteger(
      this.groupLlmTokenLimits.get(context.groupId),
      context.largeGroup
        ? this.maxLargeGroupLlmTokensPerDay
        : this.maxGroupLlmTokensPerDay,
    );
  }

  groupLlmTokenLimit(context) {
    return this.adaptiveGroupLimit(
      context.groupId,
      this.groupHardLlmTokenLimit(context),
    );
  }

  groupHardSearchLimit(context) {
    return positiveInteger(
      this.groupSearchLimits.get(context.groupId),
      context.largeGroup
        ? this.maxLargeGroupSearchCallsPerDay
        : this.maxGroupSearchCallsPerDay,
    );
  }

  groupSearchLimit(context) {
    return this.adaptiveGroupLimit(
      context.groupId,
      this.groupHardSearchLimit(context),
    );
  }

  isPassiveLlmCall(context, source) {
    const normalizedSource = String(source || context.source || '');
    return context.source === 'observed-message'
      || /(?:decision|gate|summary)/.test(normalizedSource);
  }

  shouldRunSecondaryReview({ source, issues = [], model } = {}) {
    const normalizedSource = String(source ?? '').trim();
    const primarySource = SECONDARY_REVIEW_SOURCES.get(normalizedSource);
    const normalizedIssues = [...new Set(
      (Array.isArray(issues) ? issues : [])
        .map((issue) => String(issue ?? '').trim())
        .filter(Boolean),
    )];
    if (!primarySource
      || normalizedIssues.length === 0
      || normalizedIssues.some((issue) => !LOCALLY_REPAIRABLE_REVIEW_ISSUES.has(issue))) {
      return true;
    }

    const context = this.currentContext();
    const limitPercent = context.largeGroup
      ? this.largeGroupSecondaryReviewPercent
      : 100;
    if (!context.groupId || limitPercent >= 100) return true;

    const now = this.now();
    const dayStart = startOfShanghaiDay(now);
    const database = this.ensureOpen();
    const primaryCalls = Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM qq_usage_events
      WHERE kind = 'llm' AND allowed = 1
        AND group_id = ? AND source = ?
        AND created_at >= ? AND created_at < ?
    `).get(context.groupId, primarySource, dayStart, dayStart + DAY_MS).count);
    const reviewLimit = Math.ceil(primaryCalls * limitPercent / 100);
    const reviewCalls = Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM qq_usage_events
      WHERE kind = 'llm' AND allowed = 1
        AND group_id = ? AND source = ?
        AND created_at >= ? AND created_at < ?
    `).get(context.groupId, normalizedSource, dayStart, dayStart + DAY_MS).count);
    if (reviewCalls < reviewLimit) return true;

    const estimate = database.prepare(`
      SELECT
        ROUND(AVG(input_tokens)) AS inputTokens,
        ROUND(AVG(output_tokens)) AS outputTokens,
        ROUND(AVG(cached_input_tokens)) AS cachedInputTokens
      FROM (
        SELECT input_tokens, output_tokens, cached_input_tokens
        FROM qq_usage_events
        WHERE kind = 'llm' AND allowed = 1 AND succeeded = 1
          AND group_id = ? AND source = ?
          AND total_tokens > 0 AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT 20
      )
    `).get(context.groupId, normalizedSource, now - 7 * DAY_MS);
    const inputTokens = usageNumber(estimate.inputTokens);
    const outputTokens = usageNumber(estimate.outputTokens);
    const cachedInputTokens = Math.min(
      inputTokens,
      usageNumber(estimate.cachedInputTokens),
    );
    const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
    const quotaTokens = uncachedInputTokens
      + outputTokens
      + Math.ceil(cachedInputTokens * this.cachedTokenWeightPercent / 100);
    database.prepare(`
      INSERT INTO qq_usage_events(
        created_at, group_id, user_id, message_type, kind, source, model,
        allowed, succeeded, input_tokens, output_tokens, total_tokens,
        cached_input_tokens, quota_tokens, large_group, limit_reason
      ) VALUES (?, ?, ?, ?, 'saving', ?, ?, 0, 1, ?, ?, ?, ?, ?, ?,
        'secondary-review-budget')
    `).run(
      now,
      context.groupId,
      context.userId,
      context.messageType,
      normalizedSource,
      String(model ?? '').trim(),
      inputTokens,
      outputTokens,
      inputTokens + outputTokens,
      cachedInputTokens,
      quotaTokens,
      context.largeGroup ? 1 : 0,
    );
    return false;
  }

  recordBlockedLlmCall(database, context, now, source, model, reason) {
    database.prepare(`
      INSERT INTO qq_usage_events(
        created_at, group_id, user_id, message_type, kind, source, model,
        allowed, succeeded, large_group, limit_reason
      ) VALUES (?, ?, ?, ?, 'llm', ?, ?, 0, 0, ?, ?)
    `).run(
      now,
      context.groupId,
      context.userId,
      context.messageType,
      String(source || context.source || 'llm'),
      String(model || '').trim(),
      context.largeGroup ? 1 : 0,
      reason,
    );
  }

  startLlmCall({ source, model } = {}) {
    const context = this.currentContext();
    const now = this.now();
    const database = this.ensureOpen();
    const callLimit = this.groupLlmCallLimit(context);
    if (context.groupId && callLimit > 0) {
      const used = Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM qq_usage_events
        WHERE kind = 'llm' AND allowed = 1
          AND group_id = ? AND created_at >= ?
      `).get(context.groupId, now - HOUR_MS).count);
      if (used >= callLimit) {
        this.recordBlockedLlmCall(
          database,
          context,
          now,
          source,
          model,
          'hourly-calls',
        );
        throw new QqUsageLimitError(context.groupId, callLimit, 'llm-calls');
      }
    }
    const tokenLimit = this.groupLlmTokenLimit(context);
    if (context.groupId && tokenLimit > 0) {
      const usedTokens = Number(database.prepare(`
        SELECT COALESCE(SUM(quota_tokens), 0) AS total
        FROM qq_usage_events
        WHERE kind = 'llm' AND allowed = 1
          AND group_id = ? AND created_at >= ? AND created_at < ?
      `).get(
        context.groupId,
        startOfShanghaiDay(now),
        startOfShanghaiDay(now) + DAY_MS,
      ).total);
      const passiveLimit = Math.floor(
        tokenLimit * this.passiveTokenBudgetPercent / 100,
      );
      if (passiveLimit > 0
        && this.isPassiveLlmCall(context, source)
        && usedTokens >= passiveLimit) {
        this.recordBlockedLlmCall(
          database,
          context,
          now,
          source,
          model,
          'passive-daily-tokens',
        );
        throw new QqUsageLimitError(
          context.groupId,
          passiveLimit,
          'llm-passive-tokens',
        );
      }
      if (usedTokens >= tokenLimit) {
        this.recordBlockedLlmCall(
          database,
          context,
          now,
          source,
          model,
          'daily-tokens',
        );
        throw new QqUsageLimitError(context.groupId, tokenLimit, 'llm-tokens');
      }
    }
    const result = database.prepare(`
      INSERT INTO qq_usage_events(
        created_at, group_id, user_id, message_type, kind, source, model,
        allowed, succeeded, large_group
      ) VALUES (?, ?, ?, ?, 'llm', ?, ?, 1, 0, ?)
    `).run(
      now,
      context.groupId,
      context.userId,
      context.messageType,
      String(source || context.source || 'llm'),
      String(model || '').trim(),
      context.largeGroup ? 1 : 0,
    );
    this.prune(now);
    return Number(result.lastInsertRowid);
  }

  finishLlmCall(reservationId, { usage, succeeded = true } = {}) {
    if (!reservationId) return;
    const normalizedUsage = usage?.usage ?? usage ?? {};
    const inputTokens = usageNumber(
      normalizedUsage.prompt_tokens ?? normalizedUsage.input_tokens,
    );
    const outputTokens = usageNumber(
      normalizedUsage.completion_tokens ?? normalizedUsage.output_tokens,
    );
    const totalTokens = usageNumber(
      normalizedUsage.total_tokens,
    ) || inputTokens + outputTokens;
    const cachedInputTokens = Math.min(inputTokens, usageNumber(
      normalizedUsage.prompt_cache_hit_tokens
        ?? normalizedUsage.prompt_tokens_details?.cached_tokens
        ?? normalizedUsage.input_tokens_details?.cached_tokens
        ?? normalizedUsage.cached_tokens,
    ));
    const explicitlyUncachedInputTokens = usageNumber(
      normalizedUsage.prompt_cache_miss_tokens,
    );
    const uncachedInputTokens = explicitlyUncachedInputTokens > 0
      ? explicitlyUncachedInputTokens
      : Math.max(0, inputTokens - cachedInputTokens);
    const quotaTokens = uncachedInputTokens
      + outputTokens
      + Math.ceil(cachedInputTokens * this.cachedTokenWeightPercent / 100);
    this.ensureOpen().prepare(`
      UPDATE qq_usage_events
      SET succeeded = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?,
          cached_input_tokens = ?, quota_tokens = ?
      WHERE id = ? AND kind = 'llm'
    `).run(
      succeeded ? 1 : 0,
      inputTokens,
      outputTokens,
      totalTokens,
      cachedInputTokens,
      quotaTokens,
      reservationId,
    );
  }

  startSearchCall({ source } = {}) {
    const context = this.currentContext();
    const now = this.now();
    const database = this.ensureOpen();
    const limit = this.groupSearchLimit(context);
    if (context.groupId && limit > 0) {
      const used = Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM qq_usage_events
        WHERE kind = 'search' AND allowed = 1 AND search_cache = 0
          AND group_id = ? AND created_at >= ? AND created_at < ?
      `).get(
        context.groupId,
        startOfShanghaiDay(now),
        startOfShanghaiDay(now) + DAY_MS,
      ).count);
      if (used >= limit) {
        database.prepare(`
          INSERT INTO qq_usage_events(
            created_at, group_id, user_id, message_type, kind, source,
            allowed, succeeded, large_group, limit_reason
          ) VALUES (?, ?, ?, ?, 'search', ?, 0, 0, ?, 'daily-searches')
        `).run(
          now,
          context.groupId,
          context.userId,
          context.messageType,
          String(source || context.source || 'search'),
          context.largeGroup ? 1 : 0,
        );
        throw new QqUsageLimitError(context.groupId, limit, 'search-calls');
      }
    }
    const result = database.prepare(`
      INSERT INTO qq_usage_events(
        created_at, group_id, user_id, message_type, kind, source,
        succeeded, search_results, search_cache, large_group
      ) VALUES (?, ?, ?, ?, 'search', ?, 0, 0, 0, ?)
    `).run(
      now,
      context.groupId,
      context.userId,
      context.messageType,
      String(source || context.source || 'search'),
      context.largeGroup ? 1 : 0,
    );
    return Number(result.lastInsertRowid);
  }

  finishSearchCall(reservationId, { resultCount, succeeded = true } = {}) {
    if (!reservationId) return;
    this.ensureOpen().prepare(`
      UPDATE qq_usage_events
      SET succeeded = ?, search_results = ?
      WHERE id = ? AND kind = 'search'
    `).run(succeeded ? 1 : 0, usageNumber(resultCount), reservationId);
  }

  recordSearchCacheHit({ source, resultCount } = {}) {
    const context = this.currentContext();
    this.ensureOpen().prepare(`
      INSERT INTO qq_usage_events(
        created_at, group_id, user_id, message_type, kind, source,
        succeeded, search_results, search_cache, large_group
      ) VALUES (?, ?, ?, ?, 'search', ?, 1, ?, 1, ?)
    `).run(
      this.now(),
      context.groupId,
      context.userId,
      context.messageType,
      String(source || context.source || 'search'),
      usageNumber(resultCount),
      context.largeGroup ? 1 : 0,
    );
  }

  getReport({ startAt, endAt, limit = 20 } = {}) {
    const now = this.now();
    const start = Number.isFinite(Number(startAt)) ? Number(startAt) : now - 24 * HOUR_MS;
    const end = Number.isFinite(Number(endAt)) ? Number(endAt) : now + 1;
    const rowLimit = Math.min(100, Math.max(1, positiveInteger(limit, 20)));
    const database = this.ensureOpen();
    this.prune(now);
    const availability = database.prepare(`
      SELECT MIN(created_at) AS firstAt
      FROM qq_usage_events
    `).get();
    const costRows = database.prepare(`
      SELECT
        group_id AS groupId,
        created_at AS createdAt,
        model,
        input_tokens AS inputTokens,
        cached_input_tokens AS cachedInputTokens,
        output_tokens AS outputTokens
      FROM qq_usage_events
      WHERE kind = 'llm' AND allowed = 1 AND group_id <> ''
        AND created_at >= ? AND created_at < ?
    `).all(start, end);
    const costs = calculateDeepSeekCosts(costRows);
    const savingCostRows = database.prepare(`
      SELECT
        group_id AS groupId,
        created_at AS createdAt,
        model,
        input_tokens AS inputTokens,
        cached_input_tokens AS cachedInputTokens,
        output_tokens AS outputTokens
      FROM qq_usage_events
      WHERE kind = 'saving' AND group_id <> ''
        AND created_at >= ? AND created_at < ?
    `).all(start, end);
    const savingCosts = calculateDeepSeekCosts(savingCostRows);
    const groups = database.prepare(`
      SELECT
        group_id AS groupId,
        MAX(large_group) AS largeGroup,
        SUM(CASE WHEN kind = 'request' THEN 1 ELSE 0 END) AS requests,
        SUM(CASE WHEN kind = 'llm' AND allowed = 0 THEN 1 ELSE 0 END) AS blockedLlmCalls,
        SUM(CASE WHEN kind = 'llm' AND allowed = 1 THEN 1 ELSE 0 END) AS llmCalls,
        SUM(CASE WHEN kind = 'llm' AND allowed = 1 AND succeeded = 0 THEN 1 ELSE 0 END) AS llmErrors,
        SUM(CASE WHEN kind = 'llm' AND allowed = 1 AND source IN
          ('conversation-reply', 'active-reply') THEN 1 ELSE 0 END) AS primaryReplyCalls,
        SUM(CASE WHEN kind = 'llm' AND allowed = 1 AND source IN
          ('conversation-reply-review', 'active-reply-review') THEN 1 ELSE 0 END)
          AS secondaryReviewCalls,
        SUM(CASE WHEN kind = 'saving' AND limit_reason =
          'secondary-review-budget' THEN 1 ELSE 0 END) AS skippedSecondaryReviews,
        COALESCE(SUM(CASE WHEN kind = 'saving' THEN total_tokens ELSE 0 END), 0)
          AS estimatedSavedTokens,
        COALESCE(SUM(CASE WHEN kind = 'llm' THEN input_tokens ELSE 0 END), 0) AS inputTokens,
        COALESCE(SUM(CASE WHEN kind = 'llm' THEN output_tokens ELSE 0 END), 0) AS outputTokens,
        COALESCE(SUM(CASE WHEN kind = 'llm' THEN total_tokens ELSE 0 END), 0) AS totalTokens,
        COALESCE(SUM(CASE WHEN kind = 'llm' THEN cached_input_tokens ELSE 0 END), 0) AS cachedInputTokens,
        COALESCE(SUM(CASE WHEN kind = 'llm' THEN quota_tokens ELSE 0 END), 0) AS quotaTokens,
        SUM(CASE WHEN kind = 'search' AND allowed = 0 THEN 1 ELSE 0 END) AS blockedSearchCalls,
        SUM(CASE WHEN kind = 'search' AND allowed = 1 AND search_cache = 0 THEN 1 ELSE 0 END) AS searchCalls,
        SUM(CASE WHEN kind = 'search' AND search_cache = 1 THEN 1 ELSE 0 END) AS searchCacheHits,
        MAX(created_at) AS lastAt
      FROM qq_usage_events
      WHERE group_id <> '' AND created_at >= ? AND created_at < ?
      GROUP BY group_id
      ORDER BY totalTokens DESC, llmCalls DESC, searchCalls DESC, group_id ASC
      LIMIT ?
    `).all(start, end, rowLimit).map((row) => {
      const groupContext = {
        groupId: row.groupId,
        largeGroup: Boolean(row.largeGroup),
      };
      const activity = this.getGroupActivityProfile(row.groupId, now);
      const cost = costs.byGroup.get(row.groupId) ?? serializeCostSummary(
        emptyCostSummary(),
      );
      const savingCost = savingCosts.byGroup.get(row.groupId)
        ?? serializeCostSummary(emptyCostSummary());
      return {
        ...groupContext,
        ...cost,
        estimatedSavedCostCny: savingCost.estimatedCostCny,
        activityTier: activity.tier,
        activityLimitPercent: activity.limitPercent,
        activityMessagesPerDay: activity.messagesPerDay,
        activityUsersPerDay: activity.activeUsersPerDay,
        activityLookbackDays: activity.lookbackDays,
        llmCallHardLimitPerHour: this.groupHardLlmCallLimit(groupContext) || null,
        llmCallLimitPerHour: this.groupLlmCallLimit(groupContext) || null,
        llmTokenHardLimitPerDay: this.groupHardLlmTokenLimit(groupContext) || null,
        llmTokenLimitPerDay: this.groupLlmTokenLimit(groupContext) || null,
        requests: Number(row.requests || 0),
        blockedLlmCalls: Number(row.blockedLlmCalls || 0),
        llmCalls: Number(row.llmCalls || 0),
        llmErrors: Number(row.llmErrors || 0),
        primaryReplyCalls: Number(row.primaryReplyCalls || 0),
        secondaryReviewCalls: Number(row.secondaryReviewCalls || 0),
        skippedSecondaryReviews: Number(row.skippedSecondaryReviews || 0),
        estimatedSavedTokens: Number(row.estimatedSavedTokens || 0),
        inputTokens: Number(row.inputTokens || 0),
        outputTokens: Number(row.outputTokens || 0),
        totalTokens: Number(row.totalTokens || 0),
        cachedInputTokens: Number(row.cachedInputTokens || 0),
        quotaTokens: Number(row.quotaTokens || 0),
        searchCallHardLimitPerDay: this.groupHardSearchLimit(groupContext) || null,
        searchCallLimitPerDay: this.groupSearchLimit(groupContext) || null,
        blockedSearchCalls: Number(row.blockedSearchCalls || 0),
        searchCalls: Number(row.searchCalls || 0),
        searchCacheHits: Number(row.searchCacheHits || 0),
        lastAt: Number(row.lastAt || 0),
      };
    }).sort((left, right) => (
      right.estimatedCostCny - left.estimatedCostCny
      || right.totalTokens - left.totalTokens
      || right.llmCalls - left.llmCalls
      || left.groupId.localeCompare(right.groupId)
    ));
    const totals = database.prepare(`
      SELECT
        SUM(CASE WHEN kind = 'request' THEN 1 ELSE 0 END) AS requests,
        SUM(CASE WHEN kind = 'llm' AND allowed = 0 THEN 1 ELSE 0 END) AS blockedLlmCalls,
        SUM(CASE WHEN kind = 'llm' AND allowed = 1 THEN 1 ELSE 0 END) AS llmCalls,
        SUM(CASE WHEN kind = 'llm' AND allowed = 1 AND source IN
          ('conversation-reply', 'active-reply') THEN 1 ELSE 0 END) AS primaryReplyCalls,
        SUM(CASE WHEN kind = 'llm' AND allowed = 1 AND source IN
          ('conversation-reply-review', 'active-reply-review') THEN 1 ELSE 0 END)
          AS secondaryReviewCalls,
        SUM(CASE WHEN kind = 'saving' AND limit_reason =
          'secondary-review-budget' THEN 1 ELSE 0 END) AS skippedSecondaryReviews,
        COALESCE(SUM(CASE WHEN kind = 'saving' THEN total_tokens ELSE 0 END), 0)
          AS estimatedSavedTokens,
        COALESCE(SUM(CASE WHEN kind = 'llm' THEN input_tokens ELSE 0 END), 0) AS inputTokens,
        COALESCE(SUM(CASE WHEN kind = 'llm' THEN output_tokens ELSE 0 END), 0) AS outputTokens,
        COALESCE(SUM(CASE WHEN kind = 'llm' THEN total_tokens ELSE 0 END), 0) AS totalTokens,
        COALESCE(SUM(CASE WHEN kind = 'llm' THEN cached_input_tokens ELSE 0 END), 0) AS cachedInputTokens,
        COALESCE(SUM(CASE WHEN kind = 'llm' THEN quota_tokens ELSE 0 END), 0) AS quotaTokens,
        SUM(CASE WHEN kind = 'search' AND allowed = 0 THEN 1 ELSE 0 END) AS blockedSearchCalls,
        SUM(CASE WHEN kind = 'search' AND allowed = 1 AND search_cache = 0 THEN 1 ELSE 0 END) AS searchCalls,
        SUM(CASE WHEN kind = 'search' AND search_cache = 1 THEN 1 ELSE 0 END) AS searchCacheHits
      FROM qq_usage_events
      WHERE group_id <> '' AND created_at >= ? AND created_at < ?
    `).get(start, end);
    const sources = database.prepare(`
      SELECT
        source,
        SUM(CASE WHEN kind = 'llm' AND allowed = 1 THEN 1 ELSE 0 END) AS llmCalls,
        COALESCE(SUM(CASE WHEN kind = 'llm' THEN total_tokens ELSE 0 END), 0) AS totalTokens,
        SUM(CASE WHEN kind = 'search' AND allowed = 1 AND search_cache = 0 THEN 1 ELSE 0 END) AS searchCalls
      FROM qq_usage_events
      WHERE group_id <> '' AND created_at >= ? AND created_at < ?
        AND kind IN ('llm', 'search')
      GROUP BY source
      ORDER BY totalTokens DESC, llmCalls DESC, searchCalls DESC, source ASC
    `).all(start, end).map((row) => ({
      source: row.source,
      llmCalls: Number(row.llmCalls || 0),
      totalTokens: Number(row.totalTokens || 0),
      searchCalls: Number(row.searchCalls || 0),
    }));
    return {
      startAt: start,
      endAt: end,
      dataAvailableFrom: availability.firstAt === null
        ? null
        : Number(availability.firstAt),
      pricing: {
        provider: 'deepseek',
        currency: 'CNY',
        priceUnitTokens: PRICE_UNIT_TOKENS,
        sourceUrl: DEEPSEEK_PRICING_SOURCE,
        checkedAt: DEEPSEEK_PRICING_CHECKED_AT,
        peakTimezone: 'Asia/Shanghai',
        peakPeriods: '工作日 09:00-12:00、14:00-18:00',
        ...costs.total,
      },
      adaptiveLimitsEnabled: this.adaptiveLimitsEnabled,
      activityLookbackDays: this.activityLookbackDays,
      activityMessageThresholds: this.activityMessageThresholds,
      activityUserThresholds: this.activityUserThresholds,
      activityLimitPercentages: this.activityLimitPercentages,
      groupLlmLimitPerHour: this.maxGroupLlmCallsPerHour || null,
      largeGroupLlmLimitPerHour: this.maxLargeGroupLlmCallsPerHour || null,
      groupLlmTokenLimitPerDay: this.maxGroupLlmTokensPerDay || null,
      largeGroupLlmTokenLimitPerDay: this.maxLargeGroupLlmTokensPerDay || null,
      cachedTokenWeightPercent: this.cachedTokenWeightPercent,
      passiveTokenBudgetPercent: this.passiveTokenBudgetPercent,
      largeGroupSecondaryReviewPercent: this.largeGroupSecondaryReviewPercent,
      groupSearchLimitPerDay: this.maxGroupSearchCallsPerDay || null,
      largeGroupSearchLimitPerDay: this.maxLargeGroupSearchCallsPerDay || null,
      groups,
      sources,
      totals: {
        requests: Number(totals.requests || 0),
        blockedLlmCalls: Number(totals.blockedLlmCalls || 0),
        llmCalls: Number(totals.llmCalls || 0),
        primaryReplyCalls: Number(totals.primaryReplyCalls || 0),
        secondaryReviewCalls: Number(totals.secondaryReviewCalls || 0),
        skippedSecondaryReviews: Number(totals.skippedSecondaryReviews || 0),
        estimatedSavedTokens: Number(totals.estimatedSavedTokens || 0),
        estimatedSavedCostCny: savingCosts.total.estimatedCostCny,
        inputTokens: Number(totals.inputTokens || 0),
        outputTokens: Number(totals.outputTokens || 0),
        totalTokens: Number(totals.totalTokens || 0),
        cachedInputTokens: Number(totals.cachedInputTokens || 0),
        quotaTokens: Number(totals.quotaTokens || 0),
        blockedSearchCalls: Number(totals.blockedSearchCalls || 0),
        searchCalls: Number(totals.searchCalls || 0),
        searchCacheHits: Number(totals.searchCacheHits || 0),
      },
    };
  }

  close() {
    this.database?.close();
    this.database = null;
    this.activityProfileCache.clear();
  }
}
