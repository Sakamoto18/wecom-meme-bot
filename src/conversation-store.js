import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_MESSAGES = 200;
const DEFAULT_MAX_CHARACTERS = 20_000;
const DEFAULT_MAX_CONVERSATIONS = 50;
const FILE_VERSION = 1;

function cloneMessages(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: String(message.content ?? ''),
  }));
}

function shortenContent(content, limit) {
  const normalized = String(content ?? '');
  if (normalized.length <= limit) return normalized;
  const headLength = Math.max(1, Math.floor((limit - 1) / 2));
  const tailLength = Math.max(1, limit - headLength - 1);
  return normalized.slice(0, headLength) + '…' + normalized.slice(-tailLength);
}

function fitMessages(messages, maxMessages, maxCharacters) {
  let fitted = cloneMessages(messages).slice(-maxMessages);
  const countCharacters = () => fitted.reduce(
    (total, message) => total + message.content.length,
    0,
  );

  while (fitted.length > 2 && countCharacters() > maxCharacters) {
    fitted = fitted.slice(Math.min(2, fitted.length));
  }

  if (countCharacters() > maxCharacters && fitted.length > 0) {
    const perMessageLimit = Math.max(80, Math.floor(maxCharacters / fitted.length));
    fitted = fitted.map((message) => ({
      ...message,
      content: shortenContent(message.content, perMessageLimit),
    }));
  }
  return fitted;
}

export class ConversationStore {
  constructor(options = {}) {
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
    this.maxConversations = options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.filePath = options.filePath?.trim() || '';
    this.now = options.now ?? Date.now;
    this.onPersistError = options.onPersistError ?? (() => {});
    this.entries = new Map();
    this.queues = new Map();
    this.persistQueue = Promise.resolve();
  }

  pruneExpired() {
    const currentTime = this.now();
    for (const [conversationId, entry] of this.entries) {
      if (!entry || entry.expiresAt <= currentTime) {
        this.entries.delete(conversationId);
      }
    }
  }

  enforceConversationLimit() {
    if (this.entries.size <= this.maxConversations) return;
    const oldest = [...this.entries.entries()]
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
      .slice(0, this.entries.size - this.maxConversations);
    for (const [conversationId] of oldest) {
      this.entries.delete(conversationId);
    }
  }

  get size() {
    this.pruneExpired();
    return this.entries.size;
  }

  async load() {
    if (!this.filePath) return 0;

    let body;
    try {
      body = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw new Error('读取会话记忆失败：' + error.message);
    }

    if (body?.version !== FILE_VERSION || !body.conversations || typeof body.conversations !== 'object') {
      throw new Error('读取会话记忆失败：文件格式不受支持');
    }

    const currentTime = this.now();
    for (const [conversationId, entry] of Object.entries(body.conversations)) {
      if (!Array.isArray(entry?.messages) || !Number.isFinite(entry.expiresAt)
        || entry.expiresAt <= currentTime) {
        continue;
      }
      const validMessages = entry.messages.filter((message) => (
        (message?.role === 'user' || message?.role === 'assistant')
        && typeof message.content === 'string'
      ));
      if (validMessages.length === 0) continue;
      this.entries.set(conversationId, {
        messages: fitMessages(validMessages, this.maxMessages, this.maxCharacters),
        expiresAt: entry.expiresAt,
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : currentTime,
      });
    }
    this.enforceConversationLimit();
    return this.entries.size;
  }

  get(conversationId) {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.expiresAt <= this.now()) {
      this.entries.delete(conversationId);
      return [];
    }
    return cloneMessages(entry.messages);
  }

  appendExchange(conversationId, userContent, assistantContent) {
    const currentTime = this.now();
    const messages = fitMessages([
      ...this.get(conversationId),
      { role: 'user', content: userContent },
      { role: 'assistant', content: assistantContent },
    ], this.maxMessages, this.maxCharacters);

    this.entries.set(conversationId, {
      messages,
      expiresAt: currentTime + this.ttlMs,
      updatedAt: currentTime,
    });
    this.enforceConversationLimit();
    this.schedulePersist();
  }

  clear(conversationId) {
    const deleted = this.entries.delete(conversationId);
    if (deleted) this.schedulePersist();
    return deleted;
  }

  schedulePersist() {
    if (!this.filePath) return this.persistQueue;
    this.persistQueue = this.persistQueue
      .catch(() => {})
      .then(() => this.persist())
      .catch((error) => {
        this.onPersistError(error);
      });
    return this.persistQueue;
  }

  async persist() {
    this.pruneExpired();
    const conversations = {};
    for (const [conversationId, entry] of this.entries) {
      conversations[conversationId] = {
        messages: cloneMessages(entry.messages),
        expiresAt: entry.expiresAt,
        updatedAt: entry.updatedAt,
      };
    }

    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = this.filePath + '.' + process.pid + '.tmp';
    await writeFile(temporaryPath, JSON.stringify({
      version: FILE_VERSION,
      savedAt: this.now(),
      conversations,
    }), 'utf8');
    await rename(temporaryPath, this.filePath);
  }

  async flush() {
    await this.persistQueue;
  }

  async runExclusive(conversationId, task) {
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.queues.set(conversationId, current);

    try {
      return await current;
    } finally {
      if (this.queues.get(conversationId) === current) {
        this.queues.delete(conversationId);
      }
    }
  }
}
