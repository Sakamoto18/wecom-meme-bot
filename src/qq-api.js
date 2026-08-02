import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAICompatibleChatClient } from './chat-client.js';
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
  const conversationStore = new QqMemoryStore({
    maxMessages: parsePositiveInteger(process.env.CONVERSATION_MEMORY_MESSAGES),
    maxCharacters: parsePositiveInteger(process.env.CONVERSATION_MEMORY_CHARACTERS),
    maxConversations: parsePositiveInteger(process.env.CONVERSATION_MEMORY_CONVERSATIONS),
    maxStoredMessages: parsePositiveInteger(process.env.QQ_MEMORY_MAX_STORED_MESSAGES),
    summaryTriggerMessages: parsePositiveInteger(
      process.env.QQ_MEMORY_SUMMARY_TRIGGER_MESSAGES,
    ),
    summaryKeepMessages: parsePositiveInteger(process.env.QQ_MEMORY_SUMMARY_KEEP_MESSAGES),
    maxSummaryCharacters: parsePositiveInteger(
      process.env.QQ_MEMORY_SUMMARY_MAX_CHARACTERS,
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
    process.env.LONGTU_WEB_SEARCH_ENABLED?.trim() || 'true',
  );
  const webSearch = new LongtuWebSearch({
    enabled: webSearchEnabled,
    endpoint: process.env.LONGTU_WEB_SEARCH_ENDPOINT,
    timeoutMs: parsePositiveInteger(process.env.LONGTU_WEB_SEARCH_TIMEOUT_MS),
    cacheTtlMs: parsePositiveInteger(process.env.LONGTU_WEB_SEARCH_CACHE_TTL_MS),
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
  });

  return {
    service,
    chatClient,
    conversationStore,
    memeStore,
    longtuLibrary,
    memberAliases,
    webSearchEnabled,
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
    health: () => ({
      ok: true,
      platform: 'qq',
      model_configured: runtime.chatClient.isConfigured,
      image_count: stats.longtuImageCount,
      ...runtime.conversationStore.getStats(),
    }),
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
