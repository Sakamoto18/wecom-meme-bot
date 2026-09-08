import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAICompatibleChatClient } from './chat-client.js';
import { ActiveReplyDecider } from './active-reply.js';
import { RepeatDetector } from './repeat-detector.js';
import { PeerBotContinuationDecider } from './peer-bot-gate.js';
import { MemeStore } from './meme-store.js';
import { LongtuLibrary } from './longtu-library.js';
import { parseAdminUsers, parseProtectedRoles } from './longtu-management.js';
import { QqMemoryStore } from './qq-memory-store.js';
import { QqBotService } from './qq-service.js';
import { QqUsageTracker } from './qq-usage-tracker.js';
import { LongtuWebSearch } from './web-search.js';
import { MediaResolver } from './media-resolver.js';
import { MediaUsageTracker } from './media-usage-tracker.js';
import { createXhsProvider } from './xhs-provider.js';

// DeepSeek Vision's inline request limit is 48 MiB. Keep the bridge/API
// aligned with that limit so multi-image payloads are not rejected locally.
const MAX_REQUEST_BYTES = 48 * 1024 * 1024;
const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);
const projectRoot = path.resolve(currentDirectory, '..');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonnegativeInteger(value, defaultValue = 0) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function parsePositiveNumber(value) {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBoolean(value, defaultValue = false) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return defaultValue;
  return !/^(?:0|false|off|no)$/i.test(normalized);
}

function parseProbability(value, defaultValue) {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : defaultValue;
}

function parseIdentifierSet(value) {
  return new Set(String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean));
}

function parseIdentifierNumberMap(value) {
  const result = new Map();
  for (const entry of String(value ?? '').split(',')) {
    const separator = entry.lastIndexOf('=');
    if (separator <= 0) continue;
    const identifier = entry.slice(0, separator).trim();
    const limit = parseNonnegativeInteger(entry.slice(separator + 1), -1);
    if (identifier && limit >= 0) result.set(identifier, limit);
  }
  return result;
}

function parseNonnegativeIntegerList(value) {
  const entries = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return undefined;
  const parsed = entries.map((entry) => parseNonnegativeInteger(entry, -1));
  return parsed.some((entry) => entry < 0) ? undefined : parsed;
}

async function readOptionalConfig(filePath, label) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    console.warn(`无法读取${label} ${filePath}：${error.message}`);
    return '';
  }
}

async function readMemberAliases(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('根节点必须是对象');
    }
    return Object.fromEntries(Object.entries(parsed).filter(([speakerId, alias]) => (
      /^[a-f0-9]{6}$/.test(speakerId)
      && typeof alias === 'string'
      && alias.trim()
    )));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`无法读取 QQ 群成员标注 ${filePath}：${error.message}`);
    }
    return {};
  }
}

function sendJson(response, statusCode, body) {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(serialized),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(serialized);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new HttpError(413, '请求体过大');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    throw new HttpError(400, '请求体不能为空');
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求体不是有效 JSON');
  }
}

function isAuthorized(request, expectedToken) {
  const authorization = String(request.headers.authorization ?? '');
  const providedToken = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : '';
  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(providedToken);
  return expected.length === provided.length
    && expected.length > 0
    && timingSafeEqual(expected, provided);
}

export function createQqApiServer(options) {
  const { service, apiToken } = options;
  const health = options.health ?? (() => ({ ok: true }));
  const usageTracker = options.usageTracker;
  const mediaUsageTracker = options.mediaUsageTracker;
  const mediaResolver = options.mediaResolver;
  const adminUsers = options.adminUsers ?? new Set();
  const usageReportUsers = options.usageReportUsers ?? adminUsers;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        sendJson(response, 200, await health());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/qq/usage') {
        if (!isAuthorized(request, apiToken)) {
          sendJson(response, 401, { ok: false, error: '认证失败' });
          return;
        }
        if (!usageTracker) {
          sendJson(response, 503, { ok: false, error: '用量统计尚未启用' });
          return;
        }
        const startAt = Number(url.searchParams.get('start_at'));
        const endAt = Number(url.searchParams.get('end_at'));
        const limit = Number(url.searchParams.get('limit'));
        sendJson(response, 200, {
          ok: true,
          admin_user_ids: [...adminUsers],
          report_user_ids: [...usageReportUsers],
          report: usageTracker.getReport({
            startAt: Number.isFinite(startAt) && startAt > 0 ? startAt : undefined,
            endAt: Number.isFinite(endAt) && endAt > 0 ? endAt : undefined,
            limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
          }),
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/qq/media-usage') {
        if (!isAuthorized(request, apiToken)) {
          sendJson(response, 401, { ok: false, error: '认证失败' });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          report: mediaUsageTracker?.getReport({
            startAt: Number(url.searchParams.get('start_at')) || 0,
            endAt: Number(url.searchParams.get('end_at')) || Date.now(),
          }) ?? { totals: {}, byProvider: [] },
        });
        return;
      }

      const mediaMatch = request.method === 'GET'
        ? url.pathname.match(/^\/v1\/qq\/media\/([A-Za-z0-9_-]+)$/u)
        : null;
      if (mediaMatch) {
        const mediaFile = await mediaResolver?.getMediaFile(mediaMatch[1]);
        if (!mediaFile) {
          sendJson(response, 404, { ok: false, error: '视频已过期或不存在' });
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(mediaFile.size),
          'Cache-Control': 'private, max-age=600',
          'Content-Disposition': 'inline',
          'Accept-Ranges': 'bytes',
          'X-Content-Type-Options': 'nosniff',
        });
        createReadStream(mediaFile.filePath).on('error', () => response.destroy()).pipe(response);
        return;
      }

      if (url.pathname !== '/v1/qq/message') {
        sendJson(response, 404, { ok: false, error: '接口不存在' });
        return;
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: '只允许 POST' });
        return;
      }
      if (!isAuthorized(request, apiToken)) {
        sendJson(response, 401, { ok: false, error: '认证失败' });
        return;
      }

      const payload = await readJsonBody(request);
      const result = await service.handleMessage(payload);
      sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode
        ?? (error instanceof TypeError ? 400 : 500);
      if (statusCode >= 500) {
        console.error('QQ API 处理消息失败：', error);
      }
      sendJson(response, statusCode, {
        ok: false,
        error: statusCode >= 500 ? 'QQ Bot 服务暂时不可用' : error.message,
      });
    }
  });

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}

export async function createQqRuntime() {
  const longtuIndexPath = path.join(projectRoot, 'data/longtu-index.json');
  const longtuExclusionsPath = path.join(projectRoot, 'data/longtu-exclusions.json');
  const bundledLongtuDirectory = path.join(projectRoot, 'memes', 'longtu');
  const longtuTextAliasesPath = path.join(projectRoot, 'config/longtu-text-aliases.json');
  const libraryDatabasePath = path.resolve(
    projectRoot,
    process.env.LONGTU_LIBRARY_DATABASE_FILE?.trim()
      || 'data/longtu-library.sqlite',
  );
  const libraryAssetsDirectory = path.resolve(
    projectRoot,
    process.env.LONGTU_LIBRARY_ASSETS_DIR?.trim()
      || 'data/longtu-library/assets',
  );
  const longtuLibrary = new LongtuLibrary({
    databaseFilePath: libraryDatabasePath,
    assetsDirectory: libraryAssetsDirectory,
    seedAliasesFilePath: longtuTextAliasesPath,
  });
  await longtuLibrary.load();
  const configuredLongtuLimit = parsePositiveInteger(process.env.LONGTU_LIMIT);
  const configuredLongtuMaxScore = Number.parseFloat(process.env.LONGTU_MAX_SCORE ?? '');
  const memeStore = new MemeStore([bundledLongtuDirectory], {
    longtuIndexPath,
    longtuExclusionsPath,
    trustedLongtuDirectory: bundledLongtuDirectory,
    longtuLimit: configuredLongtuLimit,
    longtuMaxScore: Number.isFinite(configuredLongtuMaxScore)
      && configuredLongtuMaxScore >= 0
      ? configuredLongtuMaxScore
      : undefined,
    longtuLibrary,
  });

  const conversationFile = process.env.QQ_CONVERSATION_MEMORY_FILE?.trim()
    || 'data/qq-conversation-memory.json';
  const memoryDatabaseFile = process.env.QQ_MEMORY_DATABASE_FILE?.trim()
    || 'data/qq-memory.sqlite';
  const rawMessageRetentionDays = parsePositiveNumber(
    process.env.QQ_MEMORY_RAW_RETENTION_DAYS,
  );
  const maintenanceHours = parsePositiveNumber(
    process.env.QQ_MEMORY_MAINTENANCE_HOURS,
  );
  const conversationStore = new QqMemoryStore({
    maxMessages: parsePositiveInteger(process.env.CONVERSATION_MEMORY_MESSAGES),
    maxCharacters: parsePositiveInteger(process.env.CONVERSATION_MEMORY_CHARACTERS),
    maxConversations: parsePositiveInteger(process.env.CONVERSATION_MEMORY_CONVERSATIONS),
    maxStoredMessages: parsePositiveInteger(process.env.QQ_MEMORY_MAX_STORED_MESSAGES),
    maxTotalStoredMessages: parsePositiveInteger(
      process.env.QQ_MEMORY_MAX_TOTAL_STORED_MESSAGES,
    ),
    minStoredMessagesPerConversation: parsePositiveInteger(
      process.env.QQ_MEMORY_MIN_MESSAGES_PER_CONVERSATION,
    ),
    rawMessageRetentionMs: rawMessageRetentionDays
      ? rawMessageRetentionDays * 24 * 60 * 60 * 1000
      : undefined,
    maintenanceIntervalMs: maintenanceHours
      ? maintenanceHours * 60 * 60 * 1000
      : undefined,
    summaryTriggerMessages: parsePositiveInteger(
      process.env.QQ_MEMORY_SUMMARY_TRIGGER_MESSAGES,
    ),
    summaryKeepMessages: parsePositiveInteger(process.env.QQ_MEMORY_SUMMARY_KEEP_MESSAGES),
    maxSummaryCharacters: parsePositiveInteger(
      process.env.QQ_MEMORY_SUMMARY_MAX_CHARACTERS,
    ),
    memberSummaryTriggerMessages: parsePositiveInteger(
      process.env.QQ_MEMBER_MEMORY_SUMMARY_TRIGGER_MESSAGES,
    ),
    memberSummaryKeepMessages: parsePositiveInteger(
      process.env.QQ_MEMBER_MEMORY_SUMMARY_KEEP_MESSAGES,
    ),
    maxMemberMemoryCharacters: parsePositiveInteger(
      process.env.QQ_MEMBER_MEMORY_MAX_CHARACTERS,
    ),
    maxMemberObservations: parsePositiveInteger(
      process.env.QQ_MEMBER_MEMORY_MAX_OBSERVATIONS,
    ),
    ttlMs: parsePositiveNumber(process.env.CONVERSATION_MEMORY_HOURS)
      ? parsePositiveNumber(process.env.CONVERSATION_MEMORY_HOURS) * 60 * 60 * 1000
      : undefined,
    databaseFilePath: path.resolve(projectRoot, memoryDatabaseFile),
    legacyFilePath: path.resolve(projectRoot, conversationFile),
    onPersistError: (error) => {
      console.warn(error.message);
    },
  });

  const usageTracker = new QqUsageTracker({
    databaseFilePath: path.resolve(
      projectRoot,
      process.env.QQ_USAGE_DATABASE_FILE?.trim() || 'data/qq-usage.sqlite',
    ),
    maxGroupLlmCallsPerHour: parseNonnegativeInteger(
      process.env.QQ_USAGE_GROUP_MAX_LLM_CALLS_PER_HOUR,
      120,
    ),
    maxLargeGroupLlmCallsPerHour: parseNonnegativeInteger(
      process.env.QQ_USAGE_LARGE_GROUP_MAX_LLM_CALLS_PER_HOUR,
      60,
    ),
    maxGroupLlmTokensPerDay: parseNonnegativeInteger(
      process.env.QQ_USAGE_GROUP_MAX_LLM_TOKENS_PER_DAY,
      2_000_000,
    ),
    maxLargeGroupLlmTokensPerDay: parseNonnegativeInteger(
      process.env.QQ_USAGE_LARGE_GROUP_MAX_LLM_TOKENS_PER_DAY,
      800_000,
    ),
    groupLlmLimits: parseIdentifierNumberMap(
      process.env.QQ_USAGE_GROUP_LLM_LIMITS,
    ),
    groupLlmTokenLimits: parseIdentifierNumberMap(
      process.env.QQ_USAGE_GROUP_LLM_DAILY_TOKEN_LIMITS,
    ),
    cachedTokenWeightPercent: parseNonnegativeInteger(
      process.env.QQ_USAGE_CACHED_TOKEN_WEIGHT_PERCENT,
      10,
    ),
    passiveTokenBudgetPercent: parseNonnegativeInteger(
      process.env.QQ_USAGE_PASSIVE_TOKEN_BUDGET_PERCENT,
      70,
    ),
    largeGroupSecondaryReviewPercent: parseNonnegativeInteger(
      process.env.QQ_USAGE_LARGE_GROUP_SECONDARY_REVIEW_PERCENT,
      20,
    ),
    adaptiveLimitsEnabled: parseBoolean(
      process.env.QQ_USAGE_ADAPTIVE_LIMITS_ENABLED,
      true,
    ),
    activityLookbackDays: parsePositiveInteger(
      process.env.QQ_USAGE_ACTIVITY_LOOKBACK_DAYS,
    ) ?? 7,
    activityMessageThresholds: parseNonnegativeIntegerList(
      process.env.QQ_USAGE_ACTIVITY_MESSAGE_THRESHOLDS,
    ),
    activityUserThresholds: parseNonnegativeIntegerList(
      process.env.QQ_USAGE_ACTIVITY_USER_THRESHOLDS,
    ),
    activityLimitPercentages: parseNonnegativeIntegerList(
      process.env.QQ_USAGE_ACTIVITY_LIMIT_PERCENTAGES,
    ),
    maxGroupSearchCallsPerDay: parseNonnegativeInteger(
      process.env.QQ_USAGE_GROUP_MAX_SEARCH_CALLS_PER_DAY,
      200,
    ),
    maxLargeGroupSearchCallsPerDay: parseNonnegativeInteger(
      process.env.QQ_USAGE_LARGE_GROUP_MAX_SEARCH_CALLS_PER_DAY,
      100,
    ),
    groupSearchLimits: parseIdentifierNumberMap(
      process.env.QQ_USAGE_GROUP_SEARCH_DAILY_LIMITS,
    ),
  });
  const mediaUsageTracker = new MediaUsageTracker({
    databaseFilePath: path.resolve(
      projectRoot,
      process.env.QQ_MEDIA_USAGE_DATABASE_FILE?.trim() || 'data/qq-media-usage.sqlite',
    ),
  });

  const webSearchEnabled = !/^(?:0|false|off)$/i.test(
    (process.env.WEB_SEARCH_ENABLED ?? process.env.LONGTU_WEB_SEARCH_ENABLED)?.trim() || 'true',
  );
  const webSearch = new LongtuWebSearch({
    enabled: webSearchEnabled,
    provider: process.env.WEB_SEARCH_PROVIDER,
    endpoint: process.env.WEB_SEARCH_ENDPOINT ?? process.env.LONGTU_WEB_SEARCH_ENDPOINT,
    exaApiKey: process.env.WEB_SEARCH_EXA_API_KEY ?? process.env.EXA_API_KEY,
    exaEndpoint: process.env.WEB_SEARCH_EXA_ENDPOINT,
    exaSearchType: process.env.WEB_SEARCH_EXA_TYPE,
    timeoutMs: parsePositiveInteger(
      process.env.WEB_SEARCH_TIMEOUT_MS ?? process.env.LONGTU_WEB_SEARCH_TIMEOUT_MS,
    ),
    cacheTtlMs: parsePositiveInteger(
      process.env.WEB_SEARCH_CACHE_TTL_MS ?? process.env.LONGTU_WEB_SEARCH_CACHE_TTL_MS,
    ),
    currentCacheTtlMs: parsePositiveInteger(
      process.env.WEB_SEARCH_CURRENT_CACHE_TTL_MS,
    ) ?? 15 * 60 * 1000,
    generalCacheTtlMs: parsePositiveInteger(
      process.env.WEB_SEARCH_GENERAL_CACHE_TTL_MS,
    ) ?? 6 * 60 * 60 * 1000,
    memeCacheTtlMs: parsePositiveInteger(
      process.env.WEB_SEARCH_MEME_CACHE_TTL_MS,
    ) ?? 12 * 60 * 60 * 1000,
    longtuCacheTtlMs: parsePositiveInteger(
      process.env.WEB_SEARCH_LONGTU_CACHE_TTL_MS,
    ) ?? 24 * 60 * 60 * 1000,
    maxResults: parsePositiveInteger(process.env.WEB_SEARCH_MAX_RESULTS),
    exaMaxContentCharacters: parsePositiveInteger(
      process.env.WEB_SEARCH_EXA_MAX_CONTENT_CHARACTERS,
    ),
  });

  const promptPath = path.resolve(
    projectRoot,
    process.env.LLM_SYSTEM_PROMPT_FILE?.trim() || 'config/system-prompt.md',
  );
  const knowledgePath = path.resolve(
    projectRoot,
    process.env.LLM_LONGTU_KNOWLEDGE_FILE?.trim() || 'config/longtu-knowledge.md',
  );
  const aliasesPath = path.resolve(
    projectRoot,
    process.env.QQ_MEMBER_ALIASES_FILE?.trim() || 'data/qq-member-aliases.json',
  );
  const [systemPrompt, knowledgeContext, memberAliases] = await Promise.all([
    readOptionalConfig(promptPath, '角色设定'),
    readOptionalConfig(knowledgePath, '龙图知识'),
    readMemberAliases(aliasesPath),
  ]);

  const chatClient = usageTracker.wrapChatClient(new OpenAICompatibleChatClient({
    apiKey: process.env.LLM_API_KEY,
    baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
    model: process.env.LLM_MODEL || 'deepseek-chat',
    systemPrompt,
  }));
  const activeReplyDecider = new ActiveReplyDecider({
    chatClient,
    enabled: parseBoolean(process.env.LONGTU_QQ_ACTIVE_REPLY_ENABLED, true),
    candidateProbability: parseProbability(
      process.env.LONGTU_QQ_ACTIVE_REPLY_PROBABILITY,
      0.3,
    ),
    questionProbability: parseProbability(
      process.env.LONGTU_QQ_ACTIVE_REPLY_QUESTION_PROBABILITY,
      0.6,
    ),
    cooldownMs: (parsePositiveNumber(
      process.env.LONGTU_QQ_ACTIVE_REPLY_COOLDOWN_SECONDS,
    ) ?? 120) * 1000,
    maxRepliesPerHour: parsePositiveInteger(
      process.env.LONGTU_QQ_ACTIVE_REPLY_MAX_PER_HOUR,
    ) ?? 6,
    contextMessages: parsePositiveInteger(
      process.env.LONGTU_QQ_ACTIVE_REPLY_CONTEXT_MESSAGES,
    ) ?? 12,
    timeoutMs: (parsePositiveNumber(
      process.env.LONGTU_QQ_ACTIVE_REPLY_DECISION_TIMEOUT_SECONDS,
    ) ?? 15) * 1000,
    allowedGroups: parseIdentifierSet(
      process.env.LONGTU_QQ_ACTIVE_REPLY_GROUPS,
    ),
    botNames: parseIdentifierSet(
      process.env.LONGTU_QQ_ACTIVE_REPLY_NAMES || '龙玉涛',
    ),
    busyWindowMs: (parsePositiveNumber(
      process.env.LONGTU_QQ_ACTIVE_REPLY_BUSY_WINDOW_SECONDS,
    ) ?? 20) * 1000,
    busyMessageCount: parsePositiveInteger(
      process.env.LONGTU_QQ_ACTIVE_REPLY_BUSY_MESSAGE_COUNT,
    ) ?? 4,
    busySenderCount: parsePositiveInteger(
      process.env.LONGTU_QQ_ACTIVE_REPLY_BUSY_SENDER_COUNT,
    ) ?? 2,
    disengageAfterMessages: parsePositiveInteger(
      process.env.LONGTU_QQ_ACTIVE_REPLY_DISENGAGE_AFTER_MESSAGES,
    ) ?? 3,
    disengageMs: (parsePositiveNumber(
      process.env.LONGTU_QQ_ACTIVE_REPLY_DISENGAGE_SECONDS,
    ) ?? 600) * 1000,
    engagementWindowMs: (parsePositiveNumber(
      process.env.LONGTU_QQ_ENGAGEMENT_WINDOW_SECONDS,
    ) ?? 100) * 1000,
    engagementReplyCooldownMs: (parsePositiveNumber(
      process.env.LONGTU_QQ_ENGAGEMENT_REPLY_COOLDOWN_SECONDS,
    ) ?? 18) * 1000,
    engagementMentionCooldownMs: (parsePositiveNumber(
      process.env.LONGTU_QQ_ENGAGEMENT_MENTION_COOLDOWN_SECONDS,
    ) ?? 5) * 1000,
    engagementReplyProbability: parseProbability(
      process.env.LONGTU_QQ_ENGAGEMENT_REPLY_PROBABILITY,
      0.6,
    ),
    engagementMaxReplies: parsePositiveInteger(
      process.env.LONGTU_QQ_ENGAGEMENT_MAX_REPLIES,
    ) ?? 4,
    semanticValueGateEnabled: parseBoolean(
      process.env.LONGTU_QQ_ACTIVE_REPLY_SEMANTIC_GATE_ENABLED,
      true,
    ),
    logger: console,
  });
  const repeatDetector = new RepeatDetector({
    enabled: parseBoolean(process.env.LONGTU_QQ_REPEAT_ENABLED, true),
    maxTextCharacters: parsePositiveInteger(
      process.env.LONGTU_QQ_REPEAT_MAX_TEXT_CHARACTERS,
    ) ?? 500,
    maxGroups: parsePositiveInteger(
      process.env.LONGTU_QQ_REPEAT_MAX_GROUPS,
    ) ?? 1_000,
    logger: console,
  });
  const peerBotContinuationDecider = new PeerBotContinuationDecider({
    chatClient,
    enabled: parseBoolean(
      process.env.LONGTU_QQ_PEER_BOT_CONTEXT_GATE_ENABLED,
      true,
    ),
    contextMessages: parsePositiveInteger(
      process.env.LONGTU_QQ_PEER_BOT_CONTEXT_MESSAGES,
    ) ?? 12,
    timeoutMs: (parsePositiveNumber(
      process.env.LONGTU_QQ_PEER_BOT_DECISION_TIMEOUT_SECONDS,
    ) ?? 10) * 1000,
    logger: console,
  });
  const adminUsers = parseAdminUsers(process.env.LONGTU_QQ_ADMIN_USERS);
  const configuredUsageReportUsers = parseAdminUsers(
    process.env.LONGTU_QQ_USAGE_REPORT_USERS,
  );
  const usageReportUsers = configuredUsageReportUsers.size > 0
    ? configuredUsageReportUsers
    : new Set(adminUsers);
  const xhsProvider = createXhsProvider({
    apiUrl: process.env.XHS_DETAIL_API_URL,
    headersJson: process.env.XHS_HEADERS_JSON,
    userAgent: process.env.XHS_USER_AGENT,
    cookie: process.env.XHS_COOKIE,
    timeoutMs: (parsePositiveNumber(process.env.XHS_PROVIDER_TIMEOUT_SECONDS) ?? 6) * 1000,
  });
  const mediaResolver = new MediaResolver({
    enabled: parseBoolean(process.env.QQ_MEDIA_EXTRACT_ENABLED, false),
    command: process.env.QQ_MEDIA_YTDLP_COMMAND?.trim() || 'yt-dlp',
    timeoutMs: (parsePositiveNumber(
      process.env.QQ_MEDIA_DOWNLOAD_TIMEOUT_SECONDS
        ?? process.env.QQ_MEDIA_RESOLVE_TIMEOUT_SECONDS,
    ) ?? 120) * 1000,
    cacheTtlMs: (parsePositiveNumber(process.env.QQ_MEDIA_RESOLVE_CACHE_TTL_SECONDS) ?? 10 * 60) * 1000,
    cacheDirectory: process.env.QQ_MEDIA_CACHE_DIRECTORY?.trim() || '/tmp/longtu-media-cache',
    maxCacheBytes: (parsePositiveNumber(process.env.QQ_MEDIA_CACHE_MAX_MIB) ?? 512) * 1024 * 1024,
    publicBaseUrl: process.env.QQ_MEDIA_PUBLIC_BASE_URL?.trim() || 'http://qq-bot:8787',
    maxConcurrent: parsePositiveInteger(process.env.QQ_MEDIA_MAX_CONCURRENT) ?? 2,
    providerResolver: xhsProvider,
    logger: console,
  });
  const service = new QqBotService({
    chatClient,
    conversationStore,
    memeStore,
    webSearch: usageTracker.wrapWebSearch(webSearch),
    webSearchEnabled,
    knowledgeContext,
    memberAliases,
    longtuLibrary,
    adminUsers,
    protectedRoles: parseProtectedRoles(process.env.LONGTU_QQ_PROTECTED_ROLES),
    activeReplyDecider,
    repeatDetector,
    peerBotContinuationDecider,
    peerBotUsers: parseIdentifierSet(process.env.LONGTU_QQ_PEER_BOT_USERS),
    peerBotMaxConsecutiveReplies: parsePositiveInteger(
      process.env.LONGTU_QQ_PEER_BOT_MAX_CONSECUTIVE_REPLIES,
    ) ?? 2,
    peerBotLoopWindowMs: (parsePositiveNumber(
      process.env.LONGTU_QQ_PEER_BOT_LOOP_WINDOW_SECONDS,
    ) ?? 300) * 1000,
    usageTracker,
    mediaUsageTracker,
    mediaResolver,
    mediaExcludedGroups: parseIdentifierSet(
      process.env.QQ_MEDIA_EXCLUDED_GROUPS,
    ),
    largeGroupIds: parseIdentifierSet(process.env.QQ_USAGE_LARGE_GROUPS),
    largeGroupExcludedIds: parseIdentifierSet(
      process.env.QQ_USAGE_LARGE_GROUP_EXCLUDES,
    ),
    largeGroupMemberThreshold: parsePositiveInteger(
      process.env.QQ_USAGE_LARGE_GROUP_MEMBER_THRESHOLD,
    ) ?? 40,
    largeGroupMemberLimitThreshold: parseNonnegativeInteger(
      process.env.QQ_USAGE_LARGE_GROUP_MEMBER_LIMIT_THRESHOLD,
      120,
    ),
    groupPassiveDecisionCooldownMs: (parsePositiveNumber(
      process.env.QQ_USAGE_GROUP_PASSIVE_DECISION_COOLDOWN_SECONDS
        ?? process.env.QQ_USAGE_LARGE_GROUP_PASSIVE_DECISION_COOLDOWN_SECONDS,
    ) ?? 180) * 1000,
    largeGroupHistoryMessages: parsePositiveInteger(
      process.env.QQ_USAGE_LARGE_GROUP_HISTORY_MESSAGES,
    ) ?? 20,
    largeGroupHistoryCharacters: parsePositiveInteger(
      process.env.QQ_USAGE_LARGE_GROUP_HISTORY_CHARACTERS,
    ) ?? 8_000,
    groupBackgroundSummariesEnabled: parseBoolean(
      process.env.QQ_USAGE_GROUP_BACKGROUND_SUMMARIES_ENABLED
        ?? process.env.QQ_USAGE_LARGE_GROUP_BACKGROUND_SUMMARIES_ENABLED,
      false,
    ),
  });

  return {
    service,
    chatClient,
    conversationStore,
    memeStore,
    longtuLibrary,
    memberAliases,
    webSearch,
    usageTracker,
    mediaUsageTracker,
    mediaResolver,
    adminUsers,
    usageReportUsers,
    webSearchEnabled,
    activeReplyEnabled: activeReplyDecider.enabled && chatClient.isConfigured,
    repeatEnabled: repeatDetector.enabled,
    peerBotContextGateEnabled: peerBotContinuationDecider.enabled
      && chatClient.isConfigured,
  };
}

export async function startQqApi() {
  const { config: loadEnvironment } = await import('dotenv');
  loadEnvironment({
    path: process.env.QQ_ENV_FILE?.trim() || path.join(projectRoot, '.env.qq'),
    quiet: true,
  });
  const apiToken = process.env.QQ_API_TOKEN?.trim();
  if (!apiToken || apiToken.length < 32 || apiToken.startsWith('请替换')) {
    throw new Error('QQ_API_TOKEN 无效；请在 .env.qq 中设置至少 32 字符的随机令牌');
  }

  const host = process.env.QQ_API_HOST?.trim() || '127.0.0.1';
  const port = parsePositiveInteger(process.env.QQ_API_PORT) ?? 8787;
  if (port > 65_535) {
    throw new Error('QQ_API_PORT 必须在 1-65535 之间');
  }

  const runtime = await createQqRuntime();
  const restoredConversationCount = await runtime.conversationStore.load();
  const stats = await runtime.memeStore.getStats();
  const server = createQqApiServer({
    service: runtime.service,
    apiToken,
    usageTracker: runtime.usageTracker,
    mediaUsageTracker: runtime.mediaUsageTracker,
    mediaResolver: runtime.mediaResolver,
    adminUsers: runtime.adminUsers,
    usageReportUsers: runtime.usageReportUsers,
    health: async () => {
      const currentStats = await runtime.memeStore.getStats();
      return {
        ok: true,
        platform: 'qq',
        model_configured: runtime.chatClient.isConfigured,
        web_search_enabled: runtime.webSearchEnabled,
        web_search_provider: runtime.webSearch.provider,
        active_reply_enabled: runtime.activeReplyEnabled,
        repeat_enabled: runtime.repeatEnabled,
        peer_bot_context_gate_enabled: runtime.peerBotContextGateEnabled,
        media_extract_enabled: runtime.mediaResolver?.enabled === true,
        image_count: currentStats.longtuImageCount,
        bundled_image_count: currentStats.longtuImageCount - currentStats.dynamicActive,
        dynamic_image_count: currentStats.dynamicActive,
        ...runtime.conversationStore.getStats(),
      };
    },
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  console.log(`QQ Bot API 已监听 http://${host}:${port}`);
  console.log(`已发现 ${stats.longtuImageCount} 张可用龙图`);
  console.log(`已恢复 ${restoredConversationCount} 个 QQ 会话记忆`);
  console.log(runtime.chatClient.isConfigured
    ? `QQ 普通对话已启用：${runtime.chatClient.model}`
    : 'QQ 普通对话未启用：缺少大模型配置');
  console.log(runtime.webSearchEnabled
    ? `QQ 联网检索已启用：${runtime.webSearch.provider}；普通模型回复默认先检索，其余查询走 general 模式`
    : 'QQ 联网检索已关闭');
  console.log(runtime.activeReplyEnabled
    ? 'QQ 群主动回复已启用：must/may/no 优先级 + 热度与退场判定，回复仍走现有 Node 引擎'
    : 'QQ 群主动回复已关闭');
  console.log(runtime.repeatEnabled
    ? 'QQ 群复读检测已启用：两位不同群友重复相同文字时只主动复读一次'
    : 'QQ 群复读检测已关闭');
  console.log(runtime.peerBotContextGateEnabled
    ? 'QQ peer Bot 续聊阀门已启用：首轮必回，后续按语境判断并保留硬上限'
    : 'QQ peer Bot 续聊阀门未启用：仅使用硬上限');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`收到 ${signal}，正在关闭 QQ Bot API……`);
    server.closeIdleConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await runtime.conversationStore.flush();
    runtime.conversationStore.close();
    runtime.longtuLibrary.close();
    runtime.usageTracker.close();
    runtime.mediaUsageTracker.close();
    runtime.mediaResolver.close();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return { server, runtime, shutdown };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  startQqApi().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
