import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAICompatibleChatClient } from './chat-client.js';
import { ActiveReplyDecider } from './active-reply.js';
import { PeerBotContinuationDecider } from './peer-bot-gate.js';
import { MemeStore } from './meme-store.js';
import { LongtuLibrary } from './longtu-library.js';
import { parseAdminUsers, parseProtectedRoles } from './longtu-management.js';
import { QqMemoryStore } from './qq-memory-store.js';
import { QqBotService } from './qq-service.js';
import { LongtuWebSearch } from './web-search.js';

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
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

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        sendJson(response, 200, await health());
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

  const webSearchEnabled = !/^(?:0|false|off)$/i.test(
    (process.env.WEB_SEARCH_ENABLED ?? process.env.LONGTU_WEB_SEARCH_ENABLED)?.trim() || 'true',
  );
  const webSearch = new LongtuWebSearch({
    enabled: webSearchEnabled,
    endpoint: process.env.WEB_SEARCH_ENDPOINT ?? process.env.LONGTU_WEB_SEARCH_ENDPOINT,
    timeoutMs: parsePositiveInteger(
      process.env.WEB_SEARCH_TIMEOUT_MS ?? process.env.LONGTU_WEB_SEARCH_TIMEOUT_MS,
    ),
    cacheTtlMs: parsePositiveInteger(
      process.env.WEB_SEARCH_CACHE_TTL_MS ?? process.env.LONGTU_WEB_SEARCH_CACHE_TTL_MS,
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

  const chatClient = new OpenAICompatibleChatClient({
    apiKey: process.env.LLM_API_KEY,
    baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
    model: process.env.LLM_MODEL || 'deepseek-chat',
    systemPrompt,
  });
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
  const service = new QqBotService({
    chatClient,
    conversationStore,
    memeStore,
    webSearch,
    webSearchEnabled,
    knowledgeContext,
    memberAliases,
    longtuLibrary,
    adminUsers: parseAdminUsers(process.env.LONGTU_QQ_ADMIN_USERS),
    protectedRoles: parseProtectedRoles(process.env.LONGTU_QQ_PROTECTED_ROLES),
    activeReplyDecider,
    peerBotContinuationDecider,
    peerBotUsers: parseIdentifierSet(process.env.LONGTU_QQ_PEER_BOT_USERS),
    peerBotMaxConsecutiveReplies: parsePositiveInteger(
      process.env.LONGTU_QQ_PEER_BOT_MAX_CONSECUTIVE_REPLIES,
    ) ?? 2,
    peerBotLoopWindowMs: (parsePositiveNumber(
      process.env.LONGTU_QQ_PEER_BOT_LOOP_WINDOW_SECONDS,
    ) ?? 300) * 1000,
  });

  return {
    service,
    chatClient,
    conversationStore,
    memeStore,
    longtuLibrary,
    memberAliases,
    webSearchEnabled,
    activeReplyEnabled: activeReplyDecider.enabled && chatClient.isConfigured,
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
    health: async () => {
      const currentStats = await runtime.memeStore.getStats();
      return {
        ok: true,
        platform: 'qq',
        model_configured: runtime.chatClient.isConfigured,
        web_search_enabled: runtime.webSearchEnabled,
        active_reply_enabled: runtime.activeReplyEnabled,
        peer_bot_context_gate_enabled: runtime.peerBotContextGateEnabled,
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
    ? 'QQ 联网检索已启用：普通模型回复默认先检索，其余查询走 general 模式'
    : 'QQ 联网检索已关闭');
  console.log(runtime.activeReplyEnabled
    ? 'QQ 群主动回复已启用：must/may/no 优先级 + 热度与退场判定，回复仍走现有 Node 引擎'
    : 'QQ 群主动回复已关闭');
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
