import {
  buildModelInput,
  getAnonymousSpeakerId,
  getConversationId,
} from './message-utils.js';
import { shouldReplyOnlyWithLongtu } from './message-routing.js';
import { generateConversationReply } from './reply-engine.js';

const MAX_MESSAGE_CHARACTERS = 20_000;
const MAX_QUOTE_CHARACTERS = 5_000;
const MAX_NAME_CHARACTERS = 80;
const MAX_IDENTIFIER_CHARACTERS = 128;
const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000;

function normalizeString(value, maxCharacters) {
  return String(value ?? '').trim().slice(0, maxCharacters);
}

function normalizeIdentifier(value, label, required = true) {
  const normalized = normalizeString(value, MAX_IDENTIFIER_CHARACTERS);
  if (required && !normalized) {
    throw new TypeError(`缺少 ${label}`);
  }
  return normalized;
}

export function normalizeQqPayload(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    throw new TypeError('请求体必须是 JSON 对象');
  }

  const messageType = payload.message_type === 'private' ? 'private' : 'group';
  const userId = normalizeIdentifier(payload.user_id, 'user_id');
  const groupId = normalizeIdentifier(
    payload.group_id,
    'group_id',
    messageType === 'group',
  );

  return {
    messageId: normalizeIdentifier(payload.message_id, 'message_id', false),
    messageType,
    userId,
    groupId,
    senderName: normalizeString(payload.sender_name, MAX_NAME_CHARACTERS),
    text: normalizeString(payload.text, MAX_MESSAGE_CHARACTERS),
    quotedText: normalizeString(payload.quoted_text, MAX_QUOTE_CHARACTERS),
    hasImage: payload.has_image === true,
  };
}

export function buildQqCompatibleMessage(payload) {
  const message = {
    msgid: payload.messageId,
    msgtype: payload.hasImage
      ? (payload.text ? 'mixed' : 'image')
      : 'text',
    chattype: payload.messageType === 'group' ? 'group' : 'single',
    chatid: payload.groupId,
    from: { userid: payload.userId },
    text: { content: payload.text },
  };

  if (payload.quotedText) {
    message.quote = {
      msgtype: 'text',
      text: { content: payload.quotedText },
    };
  }
  return message;
}

function mimeTypeForExtension(extension) {
  if (extension === '.png') return 'image/png';
  if (extension === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function imageMessage(meme) {
  return {
    type: 'image',
    filename: meme.filename,
    mime_type: mimeTypeForExtension(meme.extension),
    base64: meme.buffer.toString('base64'),
  };
}

function eventMemberAliases(message, senderName, configuredAliases) {
  const speakerId = getAnonymousSpeakerId(message);
  const aliases = senderName ? { [speakerId]: senderName } : {};
  return { ...aliases, ...configuredAliases };
}

export class QqBotService {
  constructor(options) {
    this.chatClient = options.chatClient;
    this.conversationStore = options.conversationStore;
    this.memeStore = options.memeStore;
    this.webSearch = options.webSearch;
    this.webSearchEnabled = options.webSearchEnabled ?? true;
    this.knowledgeContext = options.knowledgeContext ?? '';
    this.memberAliases = options.memberAliases ?? {};
    this.logger = options.logger ?? console;
    this.dedupeTtlMs = options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
    this.processedMessageIds = new Set();
  }

  async replyLongtu(source) {
    this.logger.log(`收到 QQ 龙图请求（来源：${source}）`);
    const meme = await this.memeStore.pick('longtu');
    this.logger.log(`QQ 已选择龙图：${meme.filename}`);
    return {
      mode: 'longtu',
      messages: [imageMessage(meme)],
    };
  }

  async replyConversation(message, content, senderName) {
    const conversationId = getConversationId(message);
    const aliases = eventMemberAliases(message, senderName, this.memberAliases);
    const modelInput = buildModelInput(message, content, aliases);

    return this.conversationStore.runExclusive(conversationId, async () => {
      const history = this.conversationStore.get(conversationId);
      const generated = await generateConversationReply({
        content,
        modelInput,
        history,
        chatClient: this.chatClient,
        webSearch: this.webSearch,
        webSearchEnabled: this.webSearchEnabled,
        knowledgeContext: this.knowledgeContext,
      });

      const answer = generated.answer;
      this.conversationStore.appendExchange(conversationId, modelInput, answer);
      const messages = [{ type: 'text', text: answer }];

      try {
        const attachedMeme = await this.memeStore.pick('longtu', {
          allowedExtensions: ['.png', '.jpg'],
        });
        messages.push(imageMessage(attachedMeme));
        this.logger.log(`QQ 普通对话已附图：${attachedMeme.filename}`);
      } catch (error) {
        this.logger.warn(`QQ 普通回复附图失败，文本不受影响：${error.message}`);
      }

      return {
        mode: generated.mode,
        messages,
      };
    });
  }

  async handleMessage(input) {
    const payload = normalizeQqPayload(input);
    const conversationTarget = payload.messageType === 'group'
      ? payload.groupId
      : payload.userId;
    const dedupeKey = payload.messageId
      ? `${payload.messageType}:${conversationTarget}:${payload.messageId}`
      : '';
    if (dedupeKey && this.processedMessageIds.has(dedupeKey)) {
      return { mode: 'duplicate', messages: [] };
    }
    if (dedupeKey) {
      this.processedMessageIds.add(dedupeKey);
      setTimeout(() => {
        this.processedMessageIds.delete(dedupeKey);
      }, this.dedupeTtlMs).unref();
    }

    try {
      return await this.handleNormalizedMessage(payload);
    } catch (error) {
      if (dedupeKey) this.processedMessageIds.delete(dedupeKey);
      throw error;
    }
  }

  async handleNormalizedMessage(payload) {
    if (!payload.text && !payload.hasImage) {
      return { mode: 'ignored', messages: [] };
    }

    const message = buildQqCompatibleMessage(payload);
    if (payload.hasImage) {
      return this.replyLongtu('用户图片');
    }

    const conversationId = getConversationId(message);
    const history = this.conversationStore.get(conversationId);
    if (shouldReplyOnlyWithLongtu(payload.text, history)) {
      return this.replyLongtu('文字请求');
    }

    return this.replyConversation(message, payload.text, payload.senderName);
  }
}
