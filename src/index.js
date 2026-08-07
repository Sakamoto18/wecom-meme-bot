import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AiBot, { generateReqId } from '@wecom/aibot-node-sdk';
import { OpenAICompatibleChatClient } from './chat-client.js';
import { ConversationStore } from './conversation-store.js';
import { MemeStore } from './meme-store.js';
import { LongtuLibrary } from './longtu-library.js';
import {
  formatLongtuAutoOcr,
  isLongtuAdministrator,
  matchLongtuAliasRequest,
  matchLongtuContextAlias,
  matchLongtuSceneAliases,
  parseAdminUsers,
  parseLongtuManagementCommand,
} from './longtu-management.js';
import {
  buildModelInput,
  extractMessageText,
  getConversationId,
  getMessageTarget,
  hasImageContent,
} from './message-utils.js';
import { shouldReplyOnlyWithLongtu } from './message-routing.js';
import { LongtuWebSearch } from './web-search.js';
import { generateConversationReply } from './reply-engine.js';

const botId = process.env.WECOM_BOT_ID?.trim();
const secret = process.env.WECOM_BOT_SECRET?.trim();

if (!botId || !secret) {
  console.error('缺少企业微信长连接凭证。请编辑项目根目录的 .env，填写 WECOM_BOT_ID 和 WECOM_BOT_SECRET。');
  process.exit(1);
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '..');
const longtuIndexPath = path.join(projectRoot, 'data/longtu-index.json');
const longtuExclusionsPath = path.join(projectRoot, 'data/longtu-exclusions.json');
const bundledLongtuDirectory = path.join(projectRoot, 'memes', 'longtu');
const longtuTextAliasesPath = path.join(projectRoot, 'config/longtu-text-aliases.json');
const emotionDirectory = process.env.WECOM_EMOTION_DIR?.trim();
const configuredLongtuLimit = Number.parseInt(process.env.LONGTU_LIMIT ?? '', 10);
const configuredLongtuMaxScore = Number.parseFloat(process.env.LONGTU_MAX_SCORE ?? '');
const longtuLibrary = new LongtuLibrary({
  databaseFilePath: path.resolve(
    projectRoot,
    process.env.LONGTU_LIBRARY_DATABASE_FILE?.trim() || 'data/longtu-library.sqlite',
  ),
  assetsDirectory: path.resolve(
    projectRoot,
    process.env.LONGTU_LIBRARY_ASSETS_DIR?.trim() || 'data/longtu-library/assets',
  ),
  seedAliasesFilePath: longtuTextAliasesPath,
});
await longtuLibrary.load();
const memeStore = new MemeStore([bundledLongtuDirectory], {
  longtuIndexPath,
  longtuExclusionsPath,
  longtuSourceDirectory: emotionDirectory,
  trustedLongtuDirectory: bundledLongtuDirectory,
  longtuLimit: Number.isInteger(configuredLongtuLimit) && configuredLongtuLimit > 0
    ? configuredLongtuLimit
    : undefined,
  longtuMaxScore: Number.isFinite(configuredLongtuMaxScore) && configuredLongtuMaxScore >= 0
    ? configuredLongtuMaxScore
    : undefined,
  longtuLibrary,
});
const wecomAdminUsers = parseAdminUsers(process.env.LONGTU_WECOM_ADMIN_USERS);
const processedMessageIds = new Set();
const managementTargets = new Map();
const MANAGEMENT_TARGET_TTL_MS = 15 * 60 * 1000;
const MANAGEMENT_TARGET_MAX_ENTRIES = 500;
const configuredMemoryMessages = Number.parseInt(process.env.CONVERSATION_MEMORY_MESSAGES ?? '', 10);
const configuredMemoryCharacters = Number.parseInt(process.env.CONVERSATION_MEMORY_CHARACTERS ?? '', 10);
const configuredMemoryHours = Number.parseFloat(process.env.CONVERSATION_MEMORY_HOURS ?? '');
const configuredMemoryConversations = Number.parseInt(process.env.CONVERSATION_MEMORY_CONVERSATIONS ?? '', 10);
const conversationStore = new ConversationStore({
  maxMessages: Number.isInteger(configuredMemoryMessages) && configuredMemoryMessages >= 4
    ? configuredMemoryMessages
    : undefined,
  maxCharacters: Number.isInteger(configuredMemoryCharacters) && configuredMemoryCharacters >= 1_000
    ? configuredMemoryCharacters
    : undefined,
  maxConversations: Number.isInteger(configuredMemoryConversations) && configuredMemoryConversations >= 1
    ? configuredMemoryConversations
    : undefined,
  ttlMs: Number.isFinite(configuredMemoryHours) && configuredMemoryHours > 0
    ? configuredMemoryHours * 60 * 60 * 1000
    : undefined,
  filePath: path.join(projectRoot, 'data', 'conversation-memory.json'),
  onPersistError: (error) => {
    console.warn('保存会话记忆失败：' + error.message);
  },
});
try {
  const restoredConversationCount = await conversationStore.load();
  console.log('已恢复 ' + restoredConversationCount + ' 个本地会话记忆');
} catch (error) {
  console.warn(error.message);
}
const webSearchEnabled = !/^(?:0|false|off)$/i.test(
  (process.env.WEB_SEARCH_ENABLED ?? process.env.LONGTU_WEB_SEARCH_ENABLED)?.trim() || 'true',
);
const configuredSearchTimeout = Number.parseInt(
  process.env.WEB_SEARCH_TIMEOUT_MS ?? process.env.LONGTU_WEB_SEARCH_TIMEOUT_MS ?? '',
  10,
);
const configuredSearchCacheTtl = Number.parseInt(
  process.env.WEB_SEARCH_CACHE_TTL_MS ?? process.env.LONGTU_WEB_SEARCH_CACHE_TTL_MS ?? '',
  10,
);
const configuredSearchMaxResults = Number.parseInt(process.env.WEB_SEARCH_MAX_RESULTS ?? '', 10);
const configuredExaMaxContentCharacters = Number.parseInt(
  process.env.WEB_SEARCH_EXA_MAX_CONTENT_CHARACTERS ?? '',
  10,
);
const webSearch = new LongtuWebSearch({
  enabled: webSearchEnabled,
  provider: process.env.WEB_SEARCH_PROVIDER,
  endpoint: process.env.WEB_SEARCH_ENDPOINT ?? process.env.LONGTU_WEB_SEARCH_ENDPOINT,
  exaApiKey: process.env.WEB_SEARCH_EXA_API_KEY ?? process.env.EXA_API_KEY,
  exaEndpoint: process.env.WEB_SEARCH_EXA_ENDPOINT,
  exaSearchType: process.env.WEB_SEARCH_EXA_TYPE,
  timeoutMs: Number.isInteger(configuredSearchTimeout) && configuredSearchTimeout > 0
    ? configuredSearchTimeout
    : undefined,
  cacheTtlMs: Number.isInteger(configuredSearchCacheTtl) && configuredSearchCacheTtl > 0
    ? configuredSearchCacheTtl
    : undefined,
  maxResults: Number.isInteger(configuredSearchMaxResults) && configuredSearchMaxResults > 0
    ? configuredSearchMaxResults
    : undefined,
  exaMaxContentCharacters: Number.isInteger(configuredExaMaxContentCharacters)
    && configuredExaMaxContentCharacters > 0
    ? configuredExaMaxContentCharacters
    : undefined,
});

const promptFile = process.env.LLM_SYSTEM_PROMPT_FILE?.trim() || 'config/system-prompt.md';
const promptPath = path.resolve(projectRoot, promptFile);
const knowledgeFile = process.env.LLM_LONGTU_KNOWLEDGE_FILE?.trim() || 'config/longtu-knowledge.md';
const knowledgePath = path.resolve(projectRoot, knowledgeFile);
const memberAliasesFile = process.env.WECOM_MEMBER_ALIASES_FILE?.trim() || 'data/member-aliases.json';
const memberAliasesPath = path.resolve(projectRoot, memberAliasesFile);

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
      console.warn(`无法读取群成员标注 ${filePath}：${error.message}`);
    }
    return {};
  }
}

const [rolePrompt, longtuKnowledge, memberAliases] = await Promise.all([
  readOptionalConfig(promptPath, '角色设定'),
  readOptionalConfig(knowledgePath, '龙图知识'),
  readMemberAliases(memberAliasesPath),
]);
const systemPrompt = rolePrompt;

const chatClient = new OpenAICompatibleChatClient({
  apiKey: process.env.LLM_API_KEY,
  baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
  model: process.env.LLM_MODEL || 'deepseek-chat',
  systemPrompt,
});

const options = {
  botId,
  secret,
  maxReconnectAttempts: -1,
};

if (process.env.WECOM_WS_URL?.trim()) {
  options.wsUrl = process.env.WECOM_WS_URL.trim();
}

const client = new AiBot.WSClient(options);

client.on('connected', () => {
  console.log('WebSocket 已连接，正在认证……');
});

client.on('authenticated', async () => {
  console.log('企业微信长连接认证成功');
  try {
    const stats = await memeStore.getStats();
    console.log(`已发现 ${stats.imageCount} 张本地表情`);
    console.log(`已提取 ${stats.longtuImageCount} 张去重后的本地龙图`);
    for (const directory of stats.directories) {
      console.log(`表情来源：${directory}`);
    }
  } catch (error) {
    console.error('扫描表情目录失败：', error);
  }
  console.log('图片能力：仅允许发送校准后的本地龙图');
  console.log(`群成员标注：已加载 ${Object.keys(memberAliases).length} 人`);
  console.log(chatClient.isConfigured
    ? `普通对话已启用：${chatClient.model}`
    : '普通对话未启用：缺少大模型配置');
  console.log(webSearchEnabled
    ? `联网资料：已启用（${webSearch.provider}；时效问题主动检索；对线仍不联网）`
    : '联网资料：已关闭');
});

function markMessageProcessed(frame) {
  const messageId = frame.body?.msgid;
  if (messageId && processedMessageIds.has(messageId)) {
    return false;
  }

  if (messageId) {
    processedMessageIds.add(messageId);
    setTimeout(() => processedMessageIds.delete(messageId), 10 * 60 * 1000).unref();
  }
  return true;
}

function wecomSelectionScope(message) {
  return `wecom:${getConversationId(message)}`;
}

function managementTargetKey(message) {
  const userId = String(message?.from?.userid ?? '').trim();
  return `${wecomSelectionScope(message)}:${userId}`;
}

function rememberManagementTarget(message, sha256) {
  const key = managementTargetKey(message);
  if (!key || !sha256) return;
  managementTargets.set(key, {
    sha256,
    expiresAt: Date.now() + MANAGEMENT_TARGET_TTL_MS,
  });
  while (managementTargets.size > MANAGEMENT_TARGET_MAX_ENTRIES) {
    managementTargets.delete(managementTargets.keys().next().value);
  }
}

function getManagementTarget(message) {
  const key = managementTargetKey(message);
  const target = managementTargets.get(key);
  if (!target) return '';
  if (target.expiresAt <= Date.now()) {
    managementTargets.delete(key);
    return '';
  }
  return target.sha256;
}

function imageDescriptorFromMessage(message) {
  if (message?.msgtype === 'image' && message.image?.url) {
    return message.image;
  }
  if (message?.msgtype === 'mixed') {
    return (message.mixed?.msg_item ?? [])
      .find((item) => item.msgtype === 'image' && item.image?.url)?.image ?? null;
  }
  return null;
}

async function downloadManagementImage(message) {
  const descriptor = imageDescriptorFromMessage(message?.quote)
    ?? imageDescriptorFromMessage(message);
  if (!descriptor?.url) return null;
  const downloaded = await client.downloadFile(descriptor.url, descriptor.aeskey);
  return downloaded?.buffer ?? null;
}

async function replyManagementText(frame, text) {
  await client.reply(frame, {
    msgtype: 'text',
    text: { content: text },
  });
}

async function handleLongtuManagement(frame, command) {
  const userId = String(frame.body?.from?.userid ?? '').trim();
  if (!isLongtuAdministrator(userId, wecomAdminUsers)) {
    await replyManagementText(frame, '你没有管理龙图库的权限。');
    return;
  }
  if (command.action === 'invalid-slash') {
    await replyManagementText(frame, command.message || '斜杠指令格式不正确。');
    return;
  }
  const actor = `wecom:${userId}`;
  try {
    if (command.action === 'status') {
      const candidates = await memeStore.getLongtuCandidates();
      const stats = longtuLibrary.getStats();
      await replyManagementText(
        frame,
        `图库可用 ${candidates.length} 张；动态加入 ${stats.dynamicActive} 张；已删除/屏蔽 ${stats.blocked} 张；管理员关键词池 ${stats.manualAliases ?? 0} 个、绑定 ${stats.manualAliasBindings ?? 0} 条；OCR 场景文字 ${stats.ocrAliases ?? 0} 个、绑定 ${stats.ocrAliasBindings ?? 0} 条。`,
      );
      return;
    }

    if (command.action === 'alias-status') {
      const manualPools = longtuLibrary.listAliasPools({ source: 'manual', limit: 100 });
      const stats = longtuLibrary.getStats();
      await replyManagementText(
        frame,
        [
          `管理员关键词池 ${stats.manualAliases ?? manualPools.length} 个，共 ${stats.manualAliasBindings ?? 0} 条图片绑定`,
          manualPools.length > 0
            ? `关键词池：${manualPools.map((entry) => `${entry.alias}(${entry.imageCount}张)`).join('、')}`
            : '目前还没有管理员关键词池',
          stats.ocrAliases > 0
            ? `OCR 场景文字标签 ${stats.ocrAliases} 条（只用于语境关键词匹配，不是需要完整输入的别名）`
            : '当前没有 OCR 场景关键词',
        ].join('；'),
      );
      return;
    }

    if (command.action === 'inspect-image') {
      const buffer = await downloadManagementImage(frame.body);
      const candidates = await memeStore.getLongtuCandidates();
      const sha256 = buffer
        ? await longtuLibrary.resolveShaByBuffer(buffer, candidates)
        : getManagementTarget(frame.body);
      if (!sha256) {
        await replyManagementText(
          frame,
          buffer
            ? '数据库核验结果：这张图不在当前龙图库中。需要收录时请引用图片发送“把这张图加入图库”。'
            : '请引用要检查的图片，再发送“检查这张图”。',
        );
        return;
      }
      rememberManagementTarget(frame.body, sha256);
      const manualAliases = longtuLibrary.listAliasesBySha(sha256, {
        source: 'manual',
      });
      const ocrAliases = longtuLibrary.listAliasesBySha(sha256, {
        source: 'ocr',
      });
      await replyManagementText(
        frame,
        [
          '数据库核验结果：这张图已在图库中',
          manualAliases.length > 0
            ? `手动标记：${manualAliases.map((entry) => entry.alias).join('、')}`
            : '尚未设置手动标记',
          `OCR 场景文字 ${ocrAliases.length} 条`,
          manualAliases.length === 0
            ? '已设为当前标记目标，15 分钟内发送“图片标记XX”即可绑定'
            : '',
        ].filter(Boolean).join('；') + '。',
      );
      return;
    }

    if (command.action === 'inspect-alias') {
      const manualBindings = longtuLibrary.resolveAliases(command.alias, { source: 'manual' });
      if (manualBindings.length === 0) {
        const sceneMatches = matchLongtuSceneAliases(
          command.alias,
          '',
          longtuLibrary.listAliases(),
        );
        if (sceneMatches.length > 0) {
          await replyManagementText(
            frame,
            `数据库核验结果：没有手动关键词池“${command.alias}”，但 OCR 场景当前匹配 ${sceneMatches.length} 张图；下面按候选池轮换返回其中一张。`,
          );
          const target = getMessageTarget(frame.body);
          const selectionOptions = {
            selectionScope: wecomSelectionScope(frame.body),
          };
          const meme = sceneMatches.length === 1
            ? await memeStore.pickBySha(sceneMatches[0].sha256, selectionOptions)
            : await memeStore.pickByShas(
              sceneMatches.map((entry) => entry.sha256),
              selectionOptions,
            );
          const mediaId = await memeStore.getMediaId(client, meme);
          await client.sendMediaMessage(target, 'image', mediaId);
          return;
        }
        await replyManagementText(
          frame,
          `数据库中没有管理员手动标记“${command.alias}”。`,
        );
        return;
      }
      await replyManagementText(
        frame,
        `数据库核验结果：手动关键词池“${command.alias}”已生效，当前包含 ${manualBindings.length} 张图；下面按池内去重轮换返回一张。`,
      );
      const target = getMessageTarget(frame.body);
      const selectionOptions = { selectionScope: wecomSelectionScope(frame.body) };
      const meme = manualBindings.length === 1
        ? await memeStore.pickBySha(manualBindings[0].sha256, selectionOptions)
        : await memeStore.pickByShas(
          manualBindings.map((entry) => entry.sha256),
          selectionOptions,
        );
      const mediaId = await memeStore.getMediaId(client, meme);
      await client.sendMediaMessage(target, 'image', mediaId);
      return;
    }

    if (command.action === 'unbind-alias') {
      const removed = longtuLibrary.unbindAlias(command.alias, { actor });
      await replyManagementText(
        frame,
        `已清空手动关键词池“${removed.alias}”，共移除 ${removed.removed} 张图的绑定。`,
      );
      return;
    }

    if (command.action === 'unbind-image-alias') {
      const buffer = await downloadManagementImage(frame.body);
      const candidates = await memeStore.getLongtuCandidates();
      const sha256 = buffer
        ? await longtuLibrary.resolveShaByBuffer(buffer, candidates)
        : getManagementTarget(frame.body);
      if (!sha256) throw new Error('请引用要取消标记的图片，或先发送“检查这张图”');
      const removed = longtuLibrary.unbindAlias(command.alias, { actor, sha256 });
      await replyManagementText(
        frame,
        `数据库已回查：已从关键词池“${removed.alias}”移除这张图，池内还剩 ${removed.poolSize} 张。`,
      );
      return;
    }

    if (command.action === 'bind-alias') {
      const buffer = await downloadManagementImage(frame.body);
      let candidates = await memeStore.getLongtuCandidates();
      let sha256 = buffer
        ? await longtuLibrary.resolveShaByBuffer(buffer, candidates)
        : getManagementTarget(frame.body);
      let added = null;
      if (buffer && !sha256) {
        added = await longtuLibrary.reviewAndAdd(buffer, {
          force: command.force,
          actor,
          referenceCandidates: candidates,
        });
        sha256 = added.sha256;
        memeStore.invalidateLongtuCandidates();
        candidates = await memeStore.getLongtuCandidates();
      }
      if (!sha256) {
        throw new Error('请把图片和 /tag 标记名放在同一条消息、引用图片，或先使用 /add');
      }
      if (!candidates.some((candidate) => candidate.sha256 === sha256)) {
        throw new Error('图片已识别，但当前图库中不可用');
      }
      rememberManagementTarget(frame.body, sha256);
      const bound = longtuLibrary.bindAlias(command.alias, sha256, { actor });
      const verifiedPool = longtuLibrary.resolveAliases(bound.alias, { source: 'manual' });
      if (!verifiedPool.some((entry) => entry.sha256 === sha256)) {
        throw new Error('数据库回查未找到刚写入的手动标记');
      }
      const verifiedAliases = longtuLibrary.listAliasesBySha(sha256, {
        source: 'manual',
      });
      await replyManagementText(
        frame,
        [
          `${bound.added ? '已加入' : '图片原本就在'}关键词池“${bound.alias}”`,
          added ? (added.forced ? '图片已由管理员强制加入图库' : '图片已通过特征复核并加入图库') : '',
          formatLongtuAutoOcr(added?.autoOcr),
          `数据库已回查：池内当前共 ${verifiedPool.length} 张图；当前图片的全部手动标记为 ${verifiedAliases.map((entry) => entry.alias).join('、')}`,
          `发送“发${bound.alias}”或在普通对话提到“${bound.alias}”，会从该池随机轮换一张。`,
        ].filter(Boolean).join('；'),
      );
      return;
    }

    if (command.action === 'add') {
      const buffer = await downloadManagementImage(frame.body);
      if (!buffer) throw new Error('请发送图文混排消息，或引用图片后发送添加指令');
      const referenceCandidates = await memeStore.getLongtuCandidates();
      const existingSha = await longtuLibrary.resolveShaByBuffer(buffer, referenceCandidates);
      if (existingSha) {
        rememberManagementTarget(frame.body, existingSha);
        await replyManagementText(frame, '这张图已经在图库中，已设为当前标记目标；15 分钟内发送 /tag 标记名即可绑定。');
        return;
      }
      const added = await longtuLibrary.reviewAndAdd(buffer, {
        force: command.force,
        actor,
        referenceCandidates,
      });
      memeStore.invalidateLongtuCandidates();
      const availableCount = (await memeStore.getLongtuCandidates()).length;
      rememberManagementTarget(frame.body, added.sha256);
      if (added.autoOcr?.status === 'failed') {
        console.warn(`龙图已入库，但自动 OCR 失败：${added.autoOcr.error}`);
      }
      await replyManagementText(
        frame,
        [
          `${added.forced ? '已强制加入' : '特征复核通过，已加入'}图库；当前可用 ${availableCount} 张`,
          formatLongtuAutoOcr(added.autoOcr),
        ].filter(Boolean).join('；') + '。',
      );
      return;
    }

    if (command.action === 'undo-delete') {
      const restored = longtuLibrary.undoDelete({ actor });
      memeStore.invalidateLongtuCandidates();
      await replyManagementText(frame, `已撤销删除：${restored.shortId}`);
      return;
    }

    const candidates = await memeStore.getLongtuCandidates();
    let sha256 = '';
    if (command.shortId) {
      const prefix = command.shortId.slice(3).toLowerCase();
      sha256 = candidates.find((candidate) => candidate.sha256?.startsWith(prefix))?.sha256
        ?? longtuLibrary.resolveShaByShortId(command.shortId);
    } else if (command.action === 'delete-previous') {
      sha256 = longtuLibrary.getLastSelection(
        wecomSelectionScope(frame.body),
      )?.sha256 ?? '';
    } else {
      const buffer = await downloadManagementImage(frame.body);
      sha256 = buffer
        ? await longtuLibrary.resolveShaByBuffer(buffer, candidates)
        : getManagementTarget(frame.body);
      if (!sha256) throw new Error('请引用要删除的图片、使用 /del LT-XXXXXXXX，或先使用 /add 设定目标');
    }
    const deleted = longtuLibrary.deleteBySha(sha256, { actor });
    memeStore.invalidateLongtuCandidates();
    await replyManagementText(
      frame,
      `已从图库移除：${deleted.shortId}。发送“撤销删除”可以恢复。`,
    );
  } catch (error) {
    const imageManagement = command.action === 'add'
      || (command.action === 'bind-alias' && Boolean(imageDescriptorFromMessage(frame.body)));
    const detail = error instanceof Error ? error.message : String(error);
    await replyManagementText(
      frame,
      imageManagement && !command.force
        ? `自动加入图库失败：${detail}；请引用这张图片后发送“强制添加这张龙图”手动添加。`
        : `图库操作未完成：${detail}`,
    );
  }
}

async function replyLongtu(frame, source = '文字请求', options = {}) {
  try {
    console.log(`收到龙图请求（来源：${source}）`);
    const selectionOptions = { selectionScope: wecomSelectionScope(frame.body) };
    const sha256s = Array.isArray(options.sha256s)
      ? [...new Set(options.sha256s.filter(Boolean))]
      : [];
    const meme = sha256s.length > 1
      ? await memeStore.pickByShas(sha256s, selectionOptions)
      : (sha256s.length === 1 || options.sha256
        ? await memeStore.pickBySha(sha256s[0] ?? options.sha256, selectionOptions)
        : await memeStore.pick('longtu', selectionOptions));
    const mediaId = await memeStore.getMediaId(client, meme);
    await client.replyMedia(frame, 'image', mediaId);
    const scoreInfo = meme.rank ? `，候选排名 ${meme.rank}，距离 ${meme.score.toFixed(4)}` : '';
    console.log(`已发送：${meme.filename}${scoreInfo}`);
  } catch (error) {
    console.error('龙图发送失败：', error);
    try {
      await client.reply(frame, {
        msgtype: 'markdown',
        markdown: { content: '龙图翻车了，请稍后再试一次 🫠' },
      });
    } catch (replyError) {
      console.error('错误提示也发送失败：', replyError);
    }
  }
}

async function replyConversation(frame, content) {
  const conversationId = getConversationId(frame.body);
  const modelInput = buildModelInput(frame.body, content, memberAliases);

  await conversationStore.runExclusive(conversationId, async () => {
    const streamId = generateReqId('stream');
    let streamStarted = false;

    try {
      await client.replyStream(frame, streamId, '正在翻龙图小本本……', false);
      streamStarted = true;
      const history = conversationStore.get(conversationId);
      const generated = await generateConversationReply({
        content,
        modelInput,
        history,
        chatClient,
        webSearch,
        webSearchEnabled,
        knowledgeContext: longtuKnowledge,
      });

      if (generated.searchError) {
        console.warn(`联网检索暂不可用：${generated.searchError.message}`);
      } else if (generated.searchAttempted) {
        const { searchResult } = generated;
        console.log(
          `联网检索（${generated.searchMode}）：${searchResult.resultCount} 条`
          + `${searchResult.fromCache ? '（缓存）' : ''}`,
        );
      }

      const answer = generated.answer;
      if (generated.mode === 'generated-attack') {
        const quality = generated.review.valid ? '通过' : `保留最佳草稿（${generated.review.issues.join(',')}）`;
        console.log(`攻击回复由简洁场景提示生成（${generated.attempts} 次，质量检查：${quality}）`);
      }
      conversationStore.appendExchange(conversationId, modelInput, answer);

      await client.replyStream(frame, streamId, answer, true);
      const responseMode = generated.mode === 'generated-attack'
        ? '直接攻击'
        : (generated.thinkingEnabled
          ? '普通对话·深度思考'
            + (generated.thinkingFallback ? '降级快速模式' : '')
            + (generated.seriousAnswerExpanded ? '·完整性复核' : '')
          : '普通对话·快速模式');
      console.log(responseMode + '已回复（' + answer.length + ' 字）');

      try {
        const target = getMessageTarget(frame.body);
        if (!target) {
          throw new Error('当前消息缺少 userid 或群聊 chatid');
        }
        const aliases = longtuLibrary.listAliases();
        const manualContextMatch = matchLongtuContextAlias(content, aliases);
        const sceneMatches = manualContextMatch
          ? manualContextMatch.sha256s.map((sha256) => ({
            alias: manualContextMatch.alias,
            matchedKeyword: manualContextMatch.alias,
            sha256,
            source: 'manual',
          }))
          : matchLongtuSceneAliases(content, answer, aliases);
        let attachedMeme;
        if (sceneMatches.length > 0) {
          try {
            const selectionOptions = {
              allowedExtensions: ['.png', '.jpg'],
              selectionScope: wecomSelectionScope(frame.body),
            };
            attachedMeme = sceneMatches.length === 1
              ? await memeStore.pickBySha(sceneMatches[0].sha256, selectionOptions)
              : await memeStore.pickByShas(
                sceneMatches.map((entry) => entry.sha256),
                selectionOptions,
              );
          } catch (error) {
            console.warn(`场景关键词对应龙图不可用，回退随机：${error.message}`);
          }
        }
        attachedMeme ??= await memeStore.pick('longtu', {
          allowedExtensions: ['.png', '.jpg'],
          selectionScope: wecomSelectionScope(frame.body),
        });
        const mediaId = await memeStore.getMediaId(client, attachedMeme);
        await client.sendMediaMessage(target, 'image', mediaId);
        console.log(`普通对话已主动附图：${attachedMeme.filename}${sceneMatches.length > 0 ? `（场景关键词：${sceneMatches[0].matchedKeyword ?? sceneMatches[0].alias}，候选 ${sceneMatches.length} 张）` : ''}`);
      } catch (imageError) {
        console.warn(`普通回复主动附图失败，文本不受影响：${imageError.message}`);
      }
    } catch (error) {
      console.error('普通对话失败：', error.message);
      const fallback = '大模型接口暂时没声了，🐎上重试一次吧。';
      try {
        if (streamStarted) {
          await client.replyStream(frame, streamId, fallback, true);
        } else {
          await client.reply(frame, {
            msgtype: 'markdown',
            markdown: { content: fallback },
          });
        }
      } catch (replyError) {
        console.error('对话错误提示也发送失败：', replyError.message);
      }
    }
  });
}

async function handleIncomingMessage(frame) {
  if (!markMessageProcessed(frame)) {
    return;
  }

  const content = extractMessageText(frame.body);
  const managementCommand = parseLongtuManagementCommand(content);
  if (managementCommand?.action === 'ignored-slash') {
    return;
  }
  if (managementCommand) {
    await handleLongtuManagement(frame, managementCommand);
    return;
  }

  if (hasImageContent(frame.body)) {
    await replyLongtu(frame, '用户图片');
    return;
  }

  if (!content) {
    return;
  }

  const aliasMatch = matchLongtuAliasRequest(content, longtuLibrary.listAliases());
  if (aliasMatch) {
    await replyLongtu(frame, `文字别名：${aliasMatch.alias}`, {
      sha256s: aliasMatch.sha256s,
    });
    return;
  }

  const conversationId = getConversationId(frame.body);
  const history = conversationStore.get(conversationId);
  if (shouldReplyOnlyWithLongtu(content, history)) {
    await replyLongtu(frame, '文字请求');
    return;
  }

  await replyConversation(frame, content);
}

function receiveMessage(frame) {
  handleIncomingMessage(frame).catch((error) => {
    console.error('处理消息失败：', error.message);
  });
}

client.on('message.text', receiveMessage);
client.on('message.image', receiveMessage);
client.on('message.voice', receiveMessage);
client.on('message.mixed', receiveMessage);

client.on('event.enter_chat', async (frame) => {
  try {
    await client.replyWelcome(frame, {
      msgtype: 'text',
      text: {
        content: '这是草莓🍓，这是蓝莓🍇，遇到我算nm倒霉',
      },
    });
  } catch (error) {
    console.error('欢迎语发送失败：', error);
  }
});

client.on('reconnecting', (attempt) => {
  console.warn(`连接断开，正在第 ${attempt} 次重连……`);
});

client.on('disconnected', (reason) => {
  console.warn('连接已断开：', reason);
});

client.on('error', (error) => {
  console.error('连接异常：', error);
});

client.connect();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在断开连接……`);
  await conversationStore.flush();
  longtuLibrary.close();
  client.disconnect();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
