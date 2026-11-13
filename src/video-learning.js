import { requestBrowserWatch } from './browser-watch-client.js';
import { VideoCurriculum } from './video-curriculum.js';
import { VideoCurriculumRetry } from './video-curriculum-retry.js';
import { createHash } from 'node:crypto';
import { Jimp } from 'jimp';
import { buildBilibiliWbiParams } from './bilibili-ai-summary.js';
import { memeKnowledgePrompt, memeReplyIntent } from './meme-knowledge.js';
import {
  COMMENT_PROMPT_BOUNDARY,
  VideoCommentCollector,
  analyzeComments,
  clusterCommentSignals,
  commentEvents,
  dedupeComments,
  rankComments,
} from './video-comments.js';

// Defaults from docs/VIDEO_MEME_LEARNING_PLAN.md §5.
export const VIDEO_LEARNING_LIMITS = Object.freeze({
  dailyTasks: 10,
  dailyMaterialSeconds: 30 * 60,
  maxSources: 3,
  taskMaterialSeconds: 5 * 60,
  maxModelCalls: 20,
  waitMs: 10 * 60 * 1000,
  failureCooldownMs: 24 * 60 * 60 * 1000,
  segmentSeconds: 27,
  tileSeconds: 9,
  dailyCatchupTasks: 3,
  catchupBrowseSlots: 1,
  enrichmentCooldownMs: 7 * 24 * 60 * 60 * 1000,
  dailyCatchupSeconds: 10 * 60,
  catchupHour: 3,
});
const KNOWN_EVIDENCE = new Set(['exact-source', 'exact-match', 'cached']);
const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const KNOWLEDGE_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const SEGMENT_PROMPT = [
  '你是视频梗分析员，正在逐段观看一个 B 站视频来弄懂一个网络梗。',
  '图片是按时间顺序拼好的截图网格，每张网格从左到右、从上到下每格间隔 1 秒，标题里写了每张网格覆盖的时间段。',
  '只根据截图、字幕/语音转写和视频信息描述你看到的东西，看不清的写进 uncertain，不要编。',
  '严格只输出 JSON：{"events":"这一段按时间发生了什么（人物动作、画面文字、台词）","joke":"这一段里的梗点或笑点机制，没有就留空","keep":["二创时必须保留的元素"],"sound_dependent":true或false（笑点是否依赖破音、变调、音效、语气这类只能听到的东西）,"uncertain":"没看清或不确定的地方"}',
].join('\n');

const DIRECT_SEGMENT_PROMPT = [
  '你是网络梗分析员，正在逐段观看用户指定的一个 B 站视频。',
  '你的任务是从视频里找出真正成立、之后还能复用的网络梗、黑话、口头禅、名场面或笑点机制；如果只是普通内容，不要硬造梗。',
  '图片是按时间顺序拼好的截图网格，每张网格从左到右、从上到下每格间隔 1 秒，标题里写了每张网格覆盖的时间段。',
  '只根据截图、字幕/语音转写和视频信息描述你看到的东西，看不清的写进 uncertain，不要编。',
  '严格只输出 JSON：{"events":"这一段按时间发生了什么（人物动作、画面文字、台词）","joke":"这一段里的梗点或笑点机制，没有就留空","keep":["二创时必须保留的元素"],"sound_dependent":true或false（笑点是否依赖破音、变调、音效、语气这类只能听到的东西）,"uncertain":"没看清或不确定的地方"}',
].join('\n');

const CATCHUP_PROMPT = [
  '下面是 QQ 群最近 24 小时的聊天记录，每行前面是匿名发言人编号。',
  '找出群友在用、但不是常用词的网络梗、黑话、谐音梗或圈内说法，要至少两个不同的人用过或者反复出现。',
  '只要公共网络梗：不要人名、群友外号、群内私事、普通词语、新闻事件、品牌或游戏名本身。',
  '严格只输出 JSON：{"memes":[{"term":"梗原文","count":出现次数,"speakers":不同发言人数,"why":"一句话说明为什么像梗"}]}，最多 8 个，按出现次数排序；没有就返回空数组。',
].join('\n');

const BROWSE_PROMPT = [
  '下面是 B 站最近发布的梗科普视频标题，带播放量。',
  '挑出最值得学的、大众网络圈子都在用的梗：优先播放量高、跨圈子通用的；跳过只在单个游戏或小圈子里流传的、名场面合集、读评论、纯搞笑段子和直播回放。',
  '每个梗写出梗名本身（去掉“梗百科”“是什么梗”这类前后缀），同一个梗只写一次。',
  '严格只输出 JSON：{"memes":[{"term":"梗名","bvid":"对应视频的 BV 号","why":"一句话说明为什么值得学"}]}，最多 6 个，按值得学的程度排序；没有合适的就返回空数组。',
].join('\n');
const BROWSE_KEYWORDS = Object.freeze(['梗百科', '是什么梗', '梗知识']);

const REUSABLE_MEME_PROMPT = '除了含义，还要学习可迁移的关系：mechanism 写原场景中哪两个动作、角色、因果或词义怎样错位，usage 写不依赖原人物姓名也成立的新场景条件，avoid 写哪些情况下不能套。不能只把它标成“抽象/反差/谐音”。保留能用于聊天的接法：reply_hooks 给出 1～3 条与证据对应的短句或改词结构，usage 说明什么时候接、接哪个点；材料不支持就留空。歌曲/鬼畜优先保留有辨识度的重复副歌和相邻短句，并逐句标注置信度；不要只写“用于调侃”，不要杜撰原作台词。';

const MERGE_PROMPT = [
  REUSABLE_MEME_PROMPT,
  '你是网络梗考据员。下面是同一个梗相关的 B 站视频逐段观察记录和视频信息。',
  '判断这些材料能不能解释用户问的梗。视频必须是在讲这个词本身；只是字面相近、谐音相近或讲的是另一个梗，就 found=false。看完仍说不清也 found=false，不要硬凑。',
  '出处只写视频里能确认的；弹幕、标题、评论只是线索。声音相关的笑点如果只有字幕或转写、没有确认声音本身，sound_unconfirmed=true。',
  '评论区归纳只是辅助证据：可以用来补充用法、歌词和网友怎么看，但不能推翻视频里明确出现的内容；评论和视频冲突时以视频为准，把冲突写进 uncertainties。',
  '严格只输出 JSON：{"found":true或false,"term":"规范梗名","aliases":["别名或常见变体"],"meaning":"一两句话说清梗义","origin":"能确认的出处，不确定留空","mechanism":"笑点机制（反差、谐音、错位、变调、重复、转折等）","usage":["常见接法或用法"],"avoid":"不适用的场景","format":"鬼畜歌曲|解说|直播切片|二创|其他","content_summary":["视频内容，最多 5 条"],"people":["涉及的人物或战队"],"lyrics":[{"line":"字幕或评论里反复出现的歌词短句，每行不超过 30 字","position":"副歌|主歌|开头|其他","confidence":"high|medium|low"}],"reply_hooks":["适合接话的说法"],"uncertainties":["说不准的地方"],"confidence":"high|medium|low","sound_unconfirmed":true或false,"unconfirmed":"仍待核实的部分"}',
].join('\n');

const DIRECT_MERGE_PROMPT = [
  REUSABLE_MEME_PROMPT,
  '你是网络梗考据员。用户直接指定了一个 B 站视频，下面是这个视频的逐段观察记录和视频信息。',
  '从视频里选出一个最值得学的梗、黑话、口头禅或名场面，term 写视频里实际出现的最短、可复用的原词或短语；如果视频没有明确可学的梗，found=false，不要硬凑。',
  '出处只写视频里能确认的；标题、简介、弹幕和评论只是线索。声音相关的笑点如果只有字幕或转写、没有确认声音本身，sound_unconfirmed=true。',
  '评论区归纳只是辅助证据：可以用来补充用法、歌词和网友怎么看，但不能推翻视频里明确出现的内容；评论和视频冲突时以视频为准，把冲突写进 uncertainties。',
  '严格只输出 JSON：{"found":true或false,"term":"规范梗名","aliases":["别名或常见变体"],"meaning":"一两句话说清梗义","origin":"能确认的出处，不确定留空","mechanism":"笑点机制（反差、谐音、错位、变调、重复、转折等）","usage":["常见接法或用法"],"avoid":"不适用的场景","format":"鬼畜歌曲|解说|直播切片|二创|其他","content_summary":["视频内容，最多 5 条"],"people":["涉及的人物或战队"],"lyrics":[{"line":"字幕或评论里反复出现的歌词短句，每行不超过 30 字","position":"副歌|主歌|开头|其他","confidence":"high|medium|low"}],"reply_hooks":["适合接话的说法"],"uncertainties":["说不准的地方"],"confidence":"high|medium|low","sound_unconfirmed":true或false,"unconfirmed":"仍待核实的部分"}',
].join('\n');

function commentMaterial(comments) {
  const insight = comments?.insight;
  if (!insight && !comments?.signals?.length) return [];
  return [
    `评论区归纳（${COMMENT_PROMPT_BOUNDARY}）：`,
    insight?.contentSummary?.length ? `  网友对内容的概括：${insight.contentSummary.join('；')}` : '',
    insight?.memeCandidates?.length
      ? `  评论区在刷：${insight.memeCandidates.slice(0, 6).map((item) => `${item.phrase}${item.meaning ? `（${item.meaning}）` : ''}[${item.confidence}]`).join('；')}`
      : '',
    insight?.lyrics?.length ? `  评论里打出的歌词：${insight.lyrics.map((line) => line.line).join(' / ')}` : '',
    insight?.reception?.summary ? `  网友怎么看：${insight.reception.summary}` : '',
    comments?.signals?.length ? `  高频片段：${comments.signals.slice(0, 8).map((item) => `${item.phrase}(${item.comments})`).join('、')}` : '',
  ].filter(Boolean);
}

export function learningTopic(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[?!.,。，、~～…]+$/u, '')
    .replace(/(?:这个|那个|这)?(?:梗|词)?(?:是什么|是啥|什么意思|啥意思|的意思|的出处|出处|来源|怎么来的|含义)(?:梗)?[？?。!！]*$/u, '')
    .replace(/(?:是什么梗|什么梗|啥梗)[？?。!！]*$/u, '')
    .replace(/^(?:wiki|百科)\s+/iu, '')
    .replace(/^(?:请问|问一下|你知道|知道|怎么就|怎么|为什么|为啥|啥叫|什么叫)/u, '')
    .replace(/[\s"“”'‘’「」《》【】]+/gu, ' ')
    .trim()
    .slice(0, 60);
}

function topicKey(value) {
  return learningTopic(value).toLowerCase().replace(/\s+/gu, '');
}

function directLinkKey(url, bvid) {
  if (bvid) return `link:${bvid.toLowerCase()}`;
  return `link:${createHash('sha256').update(String(url || '')).digest('hex').slice(0, 24)}`;
}

function startOfShanghaiDay(now) {
  return Math.floor((now + SHANGHAI_OFFSET_MS) / 86_400_000) * 86_400_000 - SHANGHAI_OFFSET_MS;
}

function parseJson(value) {
  const textValue = String(value ?? '').trim()
    .replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = textValue.indexOf('{');
  const end = textValue.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(textValue.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clean(value, limit = 500) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function list(value, limit = 6) {
  return (Array.isArray(value) ? value : []).map((item) => clean(item, 120)).filter(Boolean).slice(0, limit);
}

function formatSeconds(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function waiterKey(waiter = {}) {
  return [waiter.chatType || '', waiter.groupId || '', waiter.userId || '', waiter.messageId || ''].join(':');
}

/**
 * Finds unknown memes in direct questions, queues a learning task, watches
 * B 站 videos in the background (1 fps browser screenshots and visible captions, a
 * vision model per segment), stores the result as long-term meme knowledge
 * and queues a persona reply to every asker for the Bridge to deliver.
 */
export class VideoLearningCoordinator {
  constructor(options = {}) {
    this.store = options.store;
    this.chatClient = options.chatClient;
    this.memeKnowledge = options.memeKnowledge ?? null;
    this.memeCorpus = options.memeCorpus ?? null;
    this.personaPrompt = options.personaPrompt ?? (() => '');
    this.cookieProvider = options.cookieProvider ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.browserProviderUrl = String(options.browserProviderUrl ?? '').replace(/\/(?:resolve)?$/u, '');
    this.browserWatch = options.browserWatch ?? (async (url, seconds) => {
      if (!this.browserProviderUrl) throw new Error('未配置已登录的网页 provider，禁止回退下载');
      return requestBrowserWatch(this.browserProviderUrl, url, seconds);
    });
    this.limits = { ...VIDEO_LEARNING_LIMITS, ...(options.limits ?? {}) };
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.groupMemory = options.groupMemory ?? null;
    // Comment learning (docs/VIDEO_COMMENT_LEARNING_PLAN.md): on by default,
    // never blocks video learning when B 站 refuses or times out.
    this.comments = {
      enabled: options.comments?.enabled !== false,
      catchupEnabled: options.comments?.catchupEnabled !== false,
      maxVideos: options.comments?.maxVideos ?? 2,
      retentionMs: options.comments?.retentionMs ?? 30 * 24 * 60 * 60 * 1000,
      eventTtlMs: options.comments?.eventTtlMs ?? 7 * 24 * 60 * 60 * 1000,
      batchSize: options.comments?.batchSize ?? 40,
    };
    this.commentCollector = options.commentCollector ?? new VideoCommentCollector({
      fetchImpl: this.fetchImpl,
      headers: () => this.bilibiliHeaders(),
      logger: this.logger,
      limits: options.comments?.limits,
    });
    this.running = false;
    this.timer = null;
    this.catchupRunning = false;
    this.curriculum = new VideoCurriculum(this, options.curriculum);
    this.curriculumRetry = new VideoCurriculumRetry(this);
  }

  start(intervalMs = 15_000) {
    try {
      this.store.pruneComments(this.comments.retentionMs);
    } catch (error) {
      this.logger.warn?.(`视频评论：清理旧评论失败：${error.message}`);
    }
    const recovered = this.store.requeueInterrupted();
    if (recovered) this.logger.log?.(`视频学梗：恢复 ${recovered} 个中断任务`);
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  knowledgeFor(topic) {
    const key = topicKey(topic);
    if (!key) return null;
    const task = this.store.findLatestTask(key, 'completed');
    return task?.result?.found ? task.result.entry : null;
  }

  needsCatchup(topic) {
    const key = topicKey(topic);
    if (this.store.findActiveTask(key)
      || this.store.findLatestTask(key, 'failed', this.now() - this.limits.failureCooldownMs)) return false;
    const task = this.store.findLatestTask(key, 'completed');
    let cached = null;
    try { cached = this.memeKnowledge?.lookup?.(topic); } catch { /* optional cache */ }
    const entry = cached || (task?.result?.found ? task.result.entry : null);
    const hasHooks = entry?.replyHooks?.some((hook) => String(hook).trim());
    const hasLyrics = entry?.lyrics?.some((line) => line.line && line.confidence !== 'low');
    const song = /歌曲|鬼畜|歌词|副歌/u.test(String(
      entry?.content?.format || task?.result?.entry?.content?.format || entry?.meaning || '',
    ));
    if (hasLyrics || (hasHooks && !song)) return false;
    // A dictionary definition is not a usable reply. Enrich incomplete
    // entries at most weekly, including unsuccessful enrichment attempts
    // that still produced a valid definition.
    if (task && task.updatedAt >= this.now() - this.limits.enrichmentCooldownMs) return false;
    return true;
  }

  corpusKnows(topic) {
    if (!this.memeCorpus?.search) return false;
    const key = topicKey(topic);
    try {
      return this.memeCorpus.search(topic, { corpora: ['memewiki', 'cheer_terms', 'vbar'], limit: 6 })
        .some((row) => {
          const terms = String(row.terms ?? '').toLowerCase().replace(/\s+/gu, '');
          return terms.length >= 2 && (terms === key || (key.length >= 3 && terms.includes(key)));
        });
    } catch {
      return false;
    }
  }

  /**
   * Called from a direct reply before the model answers. Returns null to
   * answer normally, { action: 'use', entry } to answer from earlier learning,
   * or { action: 'remind' | 'silent' } once a task has been queued.
   */
  gate({
    term,
    question = '',
    evidenceQuality = 'none',
    waiter = {},
    preferredUrl = '',
    preferredBvid = '',
    directLink = false,
    background = false,
  } = {}) {
    if (directLink) {
      return this.queueDirectLink({ question, waiter, preferredUrl, preferredBvid });
    }
    const topic = learningTopic(term);
    const key = topicKey(topic);
    if (!key || key.length < 2) return null;
    const learned = this.knowledgeFor(topic);
    if (learned) return { action: 'use', entry: learned };
    if (KNOWN_EVIDENCE.has(evidenceQuality) || this.corpusKnows(topic)) return null;
    const now = this.now();
    if (this.store.findLatestTask(key, 'failed', now - this.limits.failureCooldownMs)) return null;
    const active = this.store.findActiveTask(key);
    if (!active) {
      const dayStart = startOfShanghaiDay(now);
      if (this.store.countTasksSince(dayStart) >= this.limits.dailyTasks
        || this.store.materialSecondsSince(dayStart) >= this.limits.dailyMaterialSeconds) return null;
    }
    const bvid = /^BV[0-9A-Za-z]{10}$/u.test(String(preferredBvid ?? '')) ? String(preferredBvid) : '';
    if (background) {
      // The question is already answered from search; this only watches the
      // source video so the meme store has it next time. Nobody waits.
      const queued = active ?? this.store.createOrJoinTask({
        topicKey: key,
        topic,
        question,
        metadata: { waiters: [], background: true, preferredBvid: bvid },
      }).task;
      if (!active) this.logger.log?.(`视频学梗：后台学习来源视频 topic=${topic} bvid=${bvid || '-'} task=${queued.taskKey}`);
      void this.tick();
      return { action: 'background', taskKey: queued.taskKey, topic };
    }
    const entry = { ...waiter, question: clean(question, 400), key: waiterKey(waiter) };
    const { task, joined } = this.store.createOrJoinTask({
      topicKey: key,
      topic,
      groupId: waiter.groupId,
      userId: waiter.userId,
      messageId: waiter.messageId,
      conversationId: waiter.conversationId,
      question,
      metadata: { waiters: [], ...(bvid ? { preferredBvid: bvid } : {}) },
    });
    const waiters = Array.isArray(task.metadata?.waiters) ? task.metadata.waiters : [];
    const sameChat = waiters.some((item) => item.chatType === waiter.chatType
      && item.groupId === waiter.groupId && (waiter.chatType === 'group' || item.userId === waiter.userId));
    if (!waiters.some((item) => item.key === entry.key)) {
      this.store.updateTask(task.taskKey, { metadata: { ...task.metadata, waiters: [...waiters, entry] } });
    }
    this.logger.log?.(`视频学梗：${joined ? '加入' : '新建'}任务 topic=${topic} task=${task.taskKey}`);
    void this.tick();
    return { action: joined && sameChat ? 'silent' : 'remind', taskKey: task.taskKey, topic };
  }

  queueDirectLink({ question = '', waiter = {}, preferredUrl = '', preferredBvid = '' } = {}) {
    const url = String(preferredUrl ?? '').trim();
    const bvid = /^BV[0-9A-Za-z]{10}$/u.test(String(preferredBvid ?? ''))
      ? String(preferredBvid) : '';
    if (!url && !bvid) return null;
    const key = directLinkKey(url, bvid);
    const now = this.now();
    if (this.store.findLatestTask(key, 'failed', now - this.limits.failureCooldownMs)) return null;
    const active = this.store.findActiveTask(key);
    if (!active) {
      const dayStart = startOfShanghaiDay(now);
      if (this.store.countTasksSince(dayStart) >= this.limits.dailyTasks
        || this.store.materialSecondsSince(dayStart) >= this.limits.dailyMaterialSeconds) return null;
    }
    const topic = bvid ? `B 站视频 ${bvid}` : 'B 站视频';
    const entry = { ...waiter, question: clean(question, 400), key: waiterKey(waiter) };
    const { task, joined } = this.store.createOrJoinTask({
      topicKey: key,
      topic,
      groupId: waiter.groupId,
      userId: waiter.userId,
      messageId: waiter.messageId,
      conversationId: waiter.conversationId,
      question,
      metadata: {
        waiters: [],
        directLink: true,
        topicExplicit: false,
        preferredUrl: url,
        preferredBvid: bvid,
      },
    });
    const waiters = Array.isArray(task.metadata?.waiters) ? task.metadata.waiters : [];
    const sameChat = waiters.some((item) => item.chatType === waiter.chatType
      && item.groupId === waiter.groupId && (waiter.chatType === 'group' || item.userId === waiter.userId));
    if (!waiters.some((item) => item.key === entry.key)) {
      this.store.updateTask(task.taskKey, { metadata: { ...task.metadata, waiters: [...waiters, entry] } });
    }
    this.logger.log?.(`视频学梗：${joined ? '加入' : '新建'}指定链接任务 bvid=${bvid || '-'} task=${task.taskKey}`);
    void this.tick();
    return {
      action: joined && sameChat ? 'silent' : 'remind',
      taskKey: task.taskKey,
      topic,
      directLink: true,
      topicExplicit: false,
    };
  }

  // Beijing-time day key for the catch-up run that is due now, or '' if none.
  catchupDue(now = this.now()) {
    const hour = new Date(now + SHANGHAI_OFFSET_MS).getUTCHours();
    if (hour < this.limits.catchupHour) return '';
    const day = new Date(startOfShanghaiDay(now) + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
    return this.store.getCatchupRun(day) ? '' : day;
  }

  recentGroupText(since) {
    const db = this.groupMemory?.ensureOpen?.();
    if (!db) return '';
    const rows = db.prepare(`
      SELECT user_id AS userId, text FROM qq_group_events
      WHERE author_type = 'human' AND kind = 'text' AND created_at >= ?
        AND length(text) BETWEEN 2 AND 200 AND text NOT LIKE '/%'
      ORDER BY id DESC LIMIT 1500
    `).all(since).reverse();
    const speakers = new Map();
    const lines = rows.map((row) => {
      if (!speakers.has(row.userId)) speakers.set(row.userId, `u${speakers.size + 1}`);
      return `${speakers.get(row.userId)}：${clean(row.text, 200)}`;
    });
    return lines.join('\n').slice(-20_000);
  }

  async pickCatchupTopics(since) {
    const chat = this.recentGroupText(since);
    if (!chat) return { picked: [], candidates: [] };
    const answer = await this.chatClient.complete([], chat, {
      systemPrompt: CATCHUP_PROMPT,
      maxTokens: 900,
      temperature: 0.1,
      timeoutMs: 90_000,
      thinking: { type: 'disabled' },
      usageSource: 'video-learning-catchup-pick',
    });
    const candidates = (Array.isArray(parseJson(answer)?.memes) ? parseJson(answer).memes : [])
      .map((item) => ({ term: learningTopic(item?.term), count: Number(item?.count) || 0, speakers: Number(item?.speakers) || 0 }))
      .filter((item) => topicKey(item.term).length >= 2 && (item.speakers >= 2 || item.count >= 3));
    const picked = [];
    for (const item of candidates) {
      if (picked.length >= this.limits.dailyCatchupTasks) break;
      const key = topicKey(item.term);
      if (picked.some((other) => topicKey(other.term) === key)) continue;
      if (!this.needsCatchup(item.term)) continue;
      picked.push(item);
    }
    return { picked, candidates };
  }

  // Discover recent B 站 meme explainers independently of the group queue.
  // Incomplete definitions are eligible for periodic enrichment too.
  async browseCatchupTopics(limit, excluded = []) {
    if (limit <= 0) return [];
    const headers = await this.bilibiliHeaders();
    const seen = new Set();
    const videos = [];
    for (const keyword of BROWSE_KEYWORDS) {
      try {
        const url = await this.wbiUrl('https://api.bilibili.com/x/web-interface/wbi/search/type', {
          search_type: 'video', keyword, order: 'pubdate', page: 1,
        }, headers);
        for (const row of (await this.getJson(url, headers))?.data?.result ?? []) {
          const bvid = String(row.bvid ?? '');
          if (!/^BV[0-9A-Za-z]{10}$/u.test(bvid) || seen.has(bvid)) continue;
          seen.add(bvid);
          videos.push({ bvid, title: String(row.title ?? '').replace(/<[^>]+>/gu, ''), play: Number(row.play) || 0 });
        }
      } catch (error) {
        this.logger.warn?.(`视频学梗补课：B 站梗百科搜索失败 ${keyword}：${error.message}`);
      }
    }
    if (!videos.length) return [];
    videos.sort((left, right) => right.play - left.play);
    const answer = await this.chatClient.complete([], videos.slice(0, 40)
      .map((video) => `${video.bvid}｜播放 ${video.play}｜${clean(video.title, 80)}`).join('\n'), {
      systemPrompt: BROWSE_PROMPT,
      maxTokens: 700,
      temperature: 0.1,
      timeoutMs: 90_000,
      thinking: { type: 'disabled' },
      usageSource: 'video-learning-catchup-browse',
    });
    const picked = [];
    for (const item of Array.isArray(parseJson(answer)?.memes) ? parseJson(answer).memes : []) {
      if (picked.length >= limit) break;
      const term = learningTopic(item?.term);
      const key = topicKey(term);
      if (key.length < 2 || excluded.some((other) => topicKey(other.term) === key)
        || picked.some((other) => topicKey(other.term) === key) || !this.needsCatchup(term)) continue;
      const video = videos.find((row) => row.bvid === String(item?.bvid ?? ''));
      if (!video) continue;
      picked.push({ term, source: 'bilibili', bvid: video.bvid, play: video.play || 0 });
    }
    return picked;
  }

  /**
   * Daily catch-up (plan §5): after 03:00 Beijing time, learn up to 3 public
   * memes from group chat and a reserved explainer-discovery slot, within
   * 10 minutes of material. Results only go to the meme store
   * and the admin daily report; nothing is posted to groups.
   */
  async runCatchup(day = this.catchupDue()) {
    if (!day || this.catchupRunning) return null;
    this.catchupRunning = true;
    const started = this.now();
    const run = { day, startedAt: started, items: [], candidates: [] };
    try {
      this.store.saveCatchupRun(day, { ...run, status: 'running' });
      let group = { picked: [], candidates: [] };
      try {
        group = await this.pickCatchupTopics(started - 24 * 60 * 60 * 1000);
      } catch (error) {
        this.logger.warn?.(`群聊补课选题失败，继续梗视频发现：${error.message}`);
      }
      run.candidates = group.candidates.map((item) => item.term).slice(0, 8);
      group.picked.forEach((item) => { item.source = 'group'; });
      const total = this.limits.dailyCatchupTasks;
      const reserved = Math.min(this.limits.catchupBrowseSlots, Math.max(0, total - 1));
      const groupSlots = Math.max(0, total - reserved);
      const picked = group.picked.slice(0, groupSlots);
      let browsed = [];
      try {
        browsed = await this.browseCatchupTopics(total - picked.length, picked);
      } catch (error) {
        this.logger.warn?.(`梗视频选题失败，继续群聊补课：${error.message}`);
      }
      // Give discovery a real slot before the shared material budget runs out.
      picked.unshift(...browsed.slice(0, reserved));
      picked.push(...browsed.slice(reserved));
      for (const item of group.picked.slice(groupSlots)) {
        if (picked.length >= total) break;
        if (!picked.some((other) => topicKey(other.term) === topicKey(item.term))) picked.push(item);
      }
      let seconds = 0;
      for (const item of picked) {
        const remaining = this.limits.dailyCatchupSeconds - seconds;
        if (remaining < 20) break;
        const dayStart = startOfShanghaiDay(this.now());
        const dailyRemaining = this.limits.dailyMaterialSeconds - this.store.materialSecondsSince(dayStart);
        if (dailyRemaining < 20 || this.store.countTasksSince(dayStart) >= this.limits.dailyTasks) break;
        const { task } = this.store.createOrJoinTask({
          topicKey: topicKey(item.term),
          topic: item.term,
          question: `${item.term}是什么梗`,
          metadata: {
            waiters: [],
            catchup: day,
            materialLimitSeconds: Math.min(this.limits.taskMaterialSeconds, remaining, dailyRemaining),
            // The explainer that surfaced the meme is watched first.
            preferredBvid: item.bvid || '',
          },
        });
        await this.processTask(task);
        const done = this.store.getTask(task.taskKey);
        seconds += Number(done?.result?.materialSeconds) || 0;
        run.items.push({
          term: item.term,
          source: item.source,
          status: done?.status === 'completed' ? 'learned' : 'failed',
          meaning: clean(done?.result?.entry?.meaning, 120),
          error: clean(done?.error, 80),
          seconds: Number(done?.result?.materialSeconds) || 0,
          elapsedMs: Number(done?.result?.elapsedMs) || 0,
        });
      }
      run.status = 'done';
    } catch (error) {
      run.status = 'failed';
      run.error = clean(error.message, 200);
      this.logger.warn?.(`视频学梗补课失败：${error.message}`);
    } finally {
      run.elapsedMs = this.now() - started;
      this.store.saveCatchupRun(day, run);
      this.catchupRunning = false;
    }
    this.logger.log?.(`视频学梗补课：${day} 学会 ${run.items.filter((item) => item.status === 'learned').length}/${run.items.length}，候选 ${run.candidates.length}`);
    return run;
  }

  // Latest finished catch-up run within the report window, for the daily report.
  catchupReport(startAt, endAt) {
    const run = this.store.latestCatchupRun(startAt, endAt);
    if (!run || run.startedAt < startAt || run.startedAt >= endAt) return null;
    return run;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (let task = this.store.nextQueuedTask(); task; task = this.store.nextQueuedTask()) {
        await this.processTask(task);
      }
      // On-demand learning goes first; catch-up runs once the queue is empty.
      await this.curriculumRetry.tick();
      await this.curriculum.tick();
      if (this.catchupDue()) await this.runCatchup();
    } catch (error) {
      this.logger.warn?.(`视频学梗调度失败：${error.message}`);
    } finally {
      this.running = false;
    }
  }

  async processTask(task) {
    if (Number(task.metadata?.watchRetryAt) > this.now()) return;
    // Catch-up tasks have nobody waiting, so they are not held to the wait limit.
    const catchup = Boolean(task.metadata?.catchup || task.metadata?.background);
    const budget = { modelCalls: 0, deadline: (catchup ? this.now() : task.createdAt) + this.limits.waitMs };
    const materialLimit = Number(task.metadata?.materialLimitSeconds) || this.limits.taskMaterialSeconds;
    const started = this.now();
    try {
      if (this.now() > budget.deadline) throw new Error('排队超过等待上限');
      this.store.updateTask(task.taskKey, { status: 'searching' });
      const preferred = String(task.metadata?.preferredBvid ?? '');
      const preferredUrl = String(task.metadata?.preferredUrl ?? '');
      let candidates;
      if (task.metadata?.directLink) {
        if (!preferredUrl && !preferred) throw new Error('指定视频链接无效');
        candidates = [{
          bvid: preferred,
          url: preferredUrl,
          title: '',
          description: '',
          duration: 0,
        }];
      } else {
        let found = [];
        try {
          found = await this.searchVideos(task.topic);
        } catch (error) {
          if (!preferred) throw error;
          this.logger.warn?.(`视频学梗：搜索失败，继续看指定视频：${error.message}`);
        }
        candidates = preferred
          ? [{ bvid: preferred, title: '', description: '', duration: 0 }, ...found.filter((row) => row.bvid !== preferred)]
          : found;
      }
      if (!candidates.length) throw new Error('B 站没有搜到相关视频');
      this.store.updateTask(task.taskKey, { status: 'watching' });
      const watched = [];
      const failures = [];
      let material = 0;
      for (const candidate of candidates.slice(0, this.limits.maxSources)) {
        const remaining = materialLimit - material;
        if (remaining < 10 || budget.modelCalls >= this.limits.maxModelCalls - 2) break;
        if (this.now() > budget.deadline) break;
        try {
          const result = await this.watchVideo(task, candidate, remaining, budget);
          if (result) {
            watched.push(result);
            material += result.seconds;
          }
        } catch (error) {
          if (error.code === 'WATCH_BUSY') throw error;
          failures.push(`${candidate.bvid || candidate.url}：${error.message}`);
          this.logger.warn?.(`视频学梗：${candidate.bvid} 观看失败：${error.message}`);
        }
      }
      if (!watched.length) throw new Error(`网页观看失败：${failures.join('；') || '没有有效画面'}`);
      this.store.updateTask(task.taskKey, { status: 'reviewing' });
      const merged = await this.mergeKnowledge(task, watched, budget);
      // A video that never says the term is about something else, however
      // similar it looks; such a result must not become meme knowledge.
      const groundingTopic = task.metadata?.directLink ? (merged?.term || '') : task.topic;
      const grounded = task.metadata?.directLink
        ? Boolean(groundingTopic)
        : this.mentionsTopic(groundingTopic, watched);
      const entry = merged?.found && grounded ? this.toEntry(task, merged, watched) : null;
      if (entry && merged.confidence === 'high') {
        try {
          this.memeKnowledge?.put?.(entry, { ttlMs: KNOWLEDGE_TTL_MS });
          if (merged.mechanism && merged.usage?.length) {
            this.memeKnowledge?.putAssociation?.({
              trigger: merged.usage.join('；').slice(0, 240), target: entry.term,
              mechanism: merged.mechanism, usage: entry.replyHooks?.length ? entry.replyHooks : merged.usage,
              aliases: entry.aliases, confidence: 'high', factConfidence: 'low',
              sourceUrls: entry.sourceUrls, sourceDomains: entry.sourceDomains,
            });
          }
        } catch (error) {
          this.logger.warn?.(`视频学梗：写入梗库失败：${error.message}`);
        }
      }
      if (entry && merged.confidence === 'medium') {
        try { this.memeKnowledge?.putCandidate?.(entry); }
        catch (error) { this.logger.warn?.(`视频学梗：写入候选记忆失败：${error.message}`); }
      }
      const result = {
        found: Boolean(entry),
        entry,
        merged,
        materialSeconds: material,
        sources: watched.map((item) => ({ bvid: item.bvid, title: item.title, seconds: item.seconds, transcript: item.transcriptSource, audioStatus: item.audioStatus })),
        modelCalls: budget.modelCalls,
        elapsedMs: this.now() - started,
      };
      this.store.updateTask(task.taskKey, {
        status: entry ? 'completed' : 'failed',
        result,
        error: entry ? '' : (task.metadata?.directLink
          ? '看完仍没确认这个梗'
          : (merged?.found && !grounded ? '视频里没出现这个词' : '看完仍没确认这个梗')),
      });
      await this.notifyWaiters(this.store.getTask(task.taskKey), entry ? 'result' : 'failure', entry);
      this.logger.log?.(`视频学梗：${entry ? '完成' : '未确认'} topic=${task.topic} sources=${watched.length} seconds=${material} calls=${budget.modelCalls}`);
    } catch (error) {
      if (error.code === 'WATCH_BUSY' && (Number(task.metadata?.watchBusyRetries) || 0) < 3) {
        this.store.updateTask(task.taskKey, { status: 'queued', error: error.message, metadata: {
          ...task.metadata, watchRetryAt: this.now() + 60_000,
          watchBusyRetries: (Number(task.metadata?.watchBusyRetries) || 0) + 1,
        } });
        this.logger.warn?.(`视频学习等待观看空位，60秒后继续：${task.topic}`);
        return;
      }
      this.logger.warn?.(`视频学梗：任务失败 topic=${task.topic}：${error.message}`);
      this.store.updateTask(task.taskKey, { status: 'failed', error: error.message });
      await this.notifyWaiters(this.store.getTask(task.taskKey), 'failure', null);
    }
  }

  async bilibiliHeaders(extra = {}, { requireSession = false } = {}) {
    let cookie = '';
    try {
      cookie = String(await this.cookieProvider?.() || '').trim();
    } catch {
      cookie = '';
    }
    if (requireSession && !cookie) {
      throw Object.assign(new Error('B 站登录态暂不可用（Provider 超时或未登录），已暂停主页读取，未使用匿名请求'), { retryable: true });
    }
    return { 'user-agent': SEARCH_UA, referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}), ...extra };
  }

  async getJson(url, headers) {
    const response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), {
      retryable: [412, 429].includes(response.status) || response.status >= 500,
    });
    const payload = await response.json();
    if (Number(payload?.code ?? 0) !== 0) throw Object.assign(new Error(`B 站返回 ${payload?.code} ${payload?.message || ''}`.trim()), {
      retryable: [-352, -412].includes(Number(payload?.code)),
    });
    return payload;
  }

  async wbiUrl(base, params, headers) {
    const nav = await this.fetchImpl('https://api.bilibili.com/x/web-interface/nav', { headers, signal: AbortSignal.timeout(10_000) })
      .then((response) => response.json());
    const images = nav?.data?.wbi_img;
    if (!images?.img_url || !images?.sub_url) throw new Error('B 站未返回 WBI 参数');
    const url = new URL(base);
    for (const [key, value] of Object.entries(buildBilibiliWbiParams(params, images.img_url, images.sub_url))) {
      url.searchParams.set(key, value);
    }
    return url.href;
  }

  async searchVideos(topic) {
    const headers = await this.bilibiliHeaders();
    const url = await this.wbiUrl('https://api.bilibili.com/x/web-interface/wbi/search/type', {
      search_type: 'video', keyword: `${topic} 梗`, page: 1,
    }, headers);
    const payload = await this.getJson(url, headers);
    const durationSeconds = (value) => String(value ?? '').split(':').reduce((sum, part) => sum * 60 + (Number(part) || 0), 0);
    return (payload?.data?.result ?? [])
      .map((row) => ({
        bvid: String(row.bvid ?? ''),
        title: String(row.title ?? '').replace(/<[^>]+>/gu, ''),
        description: clean(row.description, 300),
        duration: durationSeconds(row.duration),
      }))
      .filter((row) => /^BV[0-9A-Za-z]{10}$/u.test(row.bvid) && row.duration > 0)
      .slice(0, 8);
  }

  async watchVideo(task, candidate, maxSeconds, budget) {
    const sourceUrl = candidate.url || `https://www.bilibili.com/video/${candidate.bvid}`;
    const available = Math.min(maxSeconds, 300, Math.floor((budget.deadline - this.now() - 100_000) / 1000));
    if (available < 2) throw new Error('网页播放时间预算不足');
    const media = await this.browserWatch(sourceUrl, available);
    if (media.mode !== 'browser-screenshots' || !Array.isArray(media.frames) || media.frames.length < 2
      || !(media.endTime > media.startTime) || !(media.seconds > 0)) {
      throw new Error('provider 未返回实际播放的逐秒网页截图');
    }
    if (media.frames.some((frame, i) => !Number.isFinite(frame.time) || !frame.image || (i && frame.time <= media.frames[i - 1].time))) {
      throw new Error('网页截图时间轴没有连续前进');
    }
    const sourceKey = [media.bvid || candidate.bvid, media.cid, media.page || 1].join(':');
    const duration = Number(media.duration) || media.seconds;
    const seconds = media.seconds;
    const commentsPromise = this.collectComments(task, media, budget);
    const captions = media.frames.filter(frame => frame.caption).map(frame => ({
      start: frame.time, end: frame.time + 1, text: clean(frame.caption, 500),
    }));
    const audioLearned = ['transcribed', 'partial'].includes(media.audio?.status) && media.audio.transcript?.length > 0;
    const audioLines = audioLearned ? media.audio.transcript.map(line => ({ start: Number(line.start), end: Number(line.end), text: clean(line.text, 500) })) : [];
    const transcript = audioLearned ? [...audioLines, ...(media.audio.status === 'partial'
      ? captions.filter(line => !audioLines.some(audio => audio.start <= line.start && audio.end >= line.start)) : [])] : captions;
    const transcriptSource = audioLearned ? 'browser-audio-asr' : (captions.length ? 'browser-caption' : 'browser-frames');
    const audioStatus = audioLearned ? (media.audio.status === 'partial' ? media.audio.error : '已学习网页音频转写（音色、语调未核实）') : (media.audio?.error || '本次未学习音频');
    const tiles = [];
    for (let i = 0; i < media.frames.length; i += this.limits.tileSeconds) {
      const frames = media.frames.slice(i, i + this.limits.tileSeconds);
      const grid = new Jimp({ width: 1440, height: Math.ceil(frames.length / 3) * 270, color: 0x000000ff });
      for (const [offset, frame] of frames.entries()) {
        const picture = await Jimp.read(Buffer.from(frame.image, 'base64'));
        picture.contain({ w: 480, h: 270 });
        grid.composite(picture, offset % 3 * 480, Math.floor(offset / 3) * 270);
      }
      tiles.push({ image: await grid.getBuffer('image/jpeg', { quality: 80 }),
        start: frames[0].time, end: frames.at(-1).time,
        times: frames.map(frame => formatSeconds(frame.time)).join('、') });
    }
    this.store.rememberSource({
      sourceKey,
      bvid: media.bvid || candidate.bvid,
      cid: media.cid,
      page: media.page || 1,
      url: media.sourceUrl,
      title: media.title || candidate.title,
      durationSeconds: duration,
      metadata: { transcriptSource, analyzedSeconds: seconds, mode: media.mode, frameCount: media.frames.length, audioObserved: false, audioStatus, audioDiagnostics: media.audio?.diagnostics },
    });
    const observations = [];
    const tilesPerSegment = Math.max(1, Math.round(this.limits.segmentSeconds / this.limits.tileSeconds));
    for (let index = 0; index < tiles.length; index += tilesPerSegment) {
      if (budget.modelCalls >= this.limits.maxModelCalls - 2 || this.now() > budget.deadline) break;
      const start = tiles[index].start;
      const end = tiles[Math.min(tiles.length - 1, index + tilesPerSegment - 1)].end + 1;
      const lines = transcript.filter((line) => line.end >= start && line.start < end)
        .map((line) => `[${formatSeconds(line.start)}] ${line.text}`);
      const blocks = [{
        type: 'text',
        text: [
          task.metadata?.directLink
            ? '任务：从这个视频里找出最值得学的网络梗，并说明它怎么成立。'
            : `要弄懂的梗：${task.topic}`,
          `视频：${media.title || candidate.title}（${media.bvid || candidate.bvid}）`,
          media.description ? `简介：${clean(media.description, 300)}` : '',
          task.metadata?.directLink && task.question ? `用户原话：${clean(task.question, 200)}` : '',
          `本段：${formatSeconds(start)}-${formatSeconds(end)}`,
          `网页每秒截图；${audioStatus}。不得凭画面推断语调或音效。`,
          lines.length
            ? `${audioLearned ? '网页音频转写（可能有错字）' : '网页可见字幕'}：\n${lines.join('\n')}`
            : '本段没有可读取的网页字幕；只看截图里的画面和文字。',
        ].filter(Boolean).join('\n'),
      }];
      for (const tile of tiles.slice(index, index + tilesPerSegment)) {
        blocks.push({ type: 'text', text: `网页截图网格，各格实际播放时间：${tile.times}` });
        blocks.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${tile.image.toString('base64')}` } });
      }
      budget.modelCalls += 1;
      const answer = await this.chatClient.complete([], blocks, {
        systemPrompt: task.metadata?.directLink ? DIRECT_SEGMENT_PROMPT : SEGMENT_PROMPT,
        maxTokens: 700,
        temperature: 0.2,
        timeoutMs: 90_000,
        thinking: { type: 'disabled' },
        usageSource: 'video-learning-watch',
      }).catch((error) => {
        this.logger.warn?.(`视频学梗：分段分析失败：${error.message}`);
        return '';
      });
      const parsed = parseJson(answer);
      if (!parsed) continue;
      const evidence = {
        events: clean(parsed.events, 600),
        joke: clean(parsed.joke, 300),
        keep: list(parsed.keep),
        soundDependent: parsed.sound_dependent === true,
        uncertain: clean([parsed.uncertain, audioStatus].filter(Boolean).join('；'), 200),
        transcript: lines.join(' ').slice(0, 800),
      };
      this.store.addObservation({ taskKey: task.taskKey, sourceKey, startSeconds: start, endSeconds: end, evidence });
      observations.push({ start, end, ...evidence });
    }
    const reference = [media.title, media.description, ...transcript.map((line) => line.text)].join(' ');
    const comments = await this.analyzeVideoComments(task, sourceKey, media, await commentsPromise, reference, budget);
    if (!observations.length) return null;
    return {
      comments,
      bvid: media.bvid || candidate.bvid,
      title: media.title || candidate.title,
      description: clean(media.description, 300),
      aiSummary: clean(media.aiSummary, 600),
      url: media.sourceUrl,
      seconds,
      transcriptSource,
      audioStatus,
      observations,
    };
  }

  // Starts the comment fetch for one video; resolves to null when skipped.
  collectComments(task, media, budget) {
    const catchup = Boolean(task.metadata?.catchup);
    const aid = Number(media?.aid) || 0;
    budget.commentVideos = budget.commentVideos ?? 0;
    if (!this.comments.enabled || !aid || (catchup && !this.comments.catchupEnabled)
      || budget.commentVideos >= (catchup ? 1 : this.comments.maxVideos)) {
      return Promise.resolve(null);
    }
    budget.commentVideos += 1;
    return this.commentCollector.collect(aid, { catchup }).catch((error) => ({
      status: 'failed', error: error.message, comments: [], requests: 0,
    }));
  }

  async analyzeVideoComments(task, sourceKey, media, collected, reference, budget) {
    if (!collected) return { status: 'skipped' };
    const summary = { status: collected.status, collected: collected.comments.length, requests: collected.requests };
    if (!collected.comments.length) return { ...summary, error: collected.error };
    try {
      this.store.saveComments(task.taskKey, sourceKey, collected.comments);
    } catch (error) {
      this.logger.warn?.(`视频评论：保存失败：${error.message}`);
    }
    const ranked = rankComments(dedupeComments(collected.comments), { reference });
    const signals = clusterCommentSignals(ranked);
    const batches = Math.min(2, Math.ceil(ranked.length / this.comments.batchSize));
    if (!ranked.length || budget.modelCalls + batches > this.limits.maxModelCalls - 2) {
      return { ...summary, usable: ranked.length, signals };
    }
    budget.modelCalls += batches;
    const insight = await analyzeComments(this.chatClient, {
      ranked,
      signals,
      video: { title: media.title, description: media.description },
      batchSize: this.comments.batchSize,
      maxBatches: 2,
    });
    if (insight) {
      try {
        this.store.saveCommentInsights(task.taskKey, sourceKey, [
          ...insight.memeCandidates.map((item) => ({ ...item, summary: item.meaning })),
          ...insight.lyrics.map((line) => ({ kind: 'lyric', phrase: line.line, summary: line.position, frequency: line.repeatCount, confidence: line.confidence })),
          ...(insight.reception.summary ? [{ kind: 'reception', phrase: insight.reception.sentiment || 'reception', summary: insight.reception.summary, confidence: 'medium' }] : []),
          ...insight.currentEvents.map((event) => ({ kind: 'event', phrase: `${event.subject} ${event.event}`.trim(), summary: event.claim, confidence: event.confidence })),
        ]);
      } catch (error) {
        this.logger.warn?.(`视频评论：保存归纳失败：${error.message}`);
      }
    }
    this.logger.log?.(`视频评论：${collected.status} bvid=${media.bvid || '-'} comments=${collected.comments.length} usable=${ranked.length} insight=${insight ? 'yes' : 'no'}`);
    return { ...summary, usable: ranked.length, signals, insight };
  }

  mentionsTopic(topic, watched) {
    const key = topicKey(topic);
    return watched.some((video) => [
      video.title,
      video.description,
      video.aiSummary,
      ...video.observations.map((item) => `${item.transcript} ${item.events}`),
    ].join(' ').toLowerCase().replace(/\s+/gu, '').includes(key));
  }

  async mergeKnowledge(task, watched, budget) {
    budget.modelCalls += 1;
    const directLink = task.metadata?.directLink === true;
    const material = watched.map((video, index) => [
      `视频${index + 1}：${video.title}（${video.bvid}，看了 ${video.seconds} 秒，${video.audioStatus || '本次未学习音频'}）`,
      video.description ? `简介：${video.description}` : '',
      video.aiSummary ? `B 站 AI 总结：${video.aiSummary}` : '',
      ...video.observations.map((item) => [
        `[${formatSeconds(item.start)}-${formatSeconds(item.end)}] ${item.events}`,
        item.joke ? `  梗点：${item.joke}` : '',
        item.keep.length ? `  必须保留：${item.keep.join('、')}` : '',
        item.soundDependent ? '  （笑点依赖声音）' : '',
        item.uncertain ? `  不确定：${item.uncertain}` : '',
      ].filter(Boolean).join('\n')),
      ...commentMaterial(video.comments),
    ].filter(Boolean).join('\n')).join('\n\n');
    const answer = await this.chatClient.complete([], [
      directLink ? '任务：从用户指定的视频里找出最值得学的网络梗。' : `用户问的梗：${task.topic}`,
      task.question ? `用户原话：${task.question}` : '',
      '',
      material.slice(0, 12_000),
    ].filter(Boolean).join('\n'), {
      systemPrompt: directLink ? DIRECT_MERGE_PROMPT : MERGE_PROMPT,
      maxTokens: 1_800,
      temperature: 0.1,
      timeoutMs: 90_000,
      thinking: { type: 'disabled' },
      usageSource: 'video-learning-merge',
    });
    const parsed = parseJson(answer);
    if (!parsed) return null;
    const soundDependent = watched.some((video) => video.observations.some((item) => item.soundDependent));
    const noAudio = watched.every((video) => video.transcriptSource !== 'browser-audio-asr');
    const term = clean(parsed.term, 60) || (directLink ? '' : task.topic);
    return {
      found: parsed.found === true && clean(parsed.meaning).length >= 4,
      term,
      aliases: list(parsed.aliases, 8),
      meaning: clean(parsed.meaning, 300),
      origin: clean(parsed.origin, 200),
      mechanism: clean(parsed.mechanism, 200),
      usage: list(parsed.usage, 5),
      avoid: clean(parsed.avoid, 200),
      format: clean(parsed.format, 20),
      contentSummary: list(parsed.content_summary, 5),
      people: list(parsed.people, 6),
      lyrics: (Array.isArray(parsed.lyrics) ? parsed.lyrics : [])
        .map((line) => ({ line: clean(line?.line, 30), position: clean(line?.position, 10), confidence: ['high', 'medium', 'low'].includes(line?.confidence) ? line.confidence : 'low' }))
        .filter((line) => line.line).slice(0, 8),
      replyHooks: list(parsed.reply_hooks, 6),
      uncertainties: list(parsed.uncertainties, 4),
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
      // ASR gives words, not pitch or sound effects.
      soundUnconfirmed: parsed.sound_unconfirmed === true || soundDependent || noAudio,
      unconfirmed: clean(parsed.unconfirmed, 200),
    };
  }

  toEntry(task, merged, watched) {
    if (merged.confidence === 'low') return null;
    const meaning = [
      merged.meaning,
      merged.confidence === 'high' && merged.origin ? `出处：${merged.origin}` : '',
      merged.mechanism ? `笑点：${merged.mechanism}` : '',
      merged.soundUnconfirmed ? '（声音因素未确认）' : '',
    ].filter(Boolean).join(' ');
    const aliases = task.metadata?.directLink ? merged.aliases : [task.topic, ...merged.aliases];
    return {
      term: merged.term || task.topic,
      aliases: [...new Set(aliases.filter((alias) => alias && alias !== merged.term))],
      meaning: clean(meaning, 500),
      usage: [...merged.usage, merged.avoid ? `不适用：${merged.avoid}` : ''].filter(Boolean),
      sourceDomains: ['bilibili.com'],
      sourceUrls: watched.map((video) => video.url).filter(Boolean),
      confidence: merged.confidence,
      lookupSource: 'video',
      verified: merged.confidence === 'high',
      unconfirmed: merged.unconfirmed,
      ...this.richFields(merged, watched),
      ...(merged.confidence !== 'high' ? { lyrics: [], currentEvents: [], reception: {}, replyHooks: [] } : {}),
    };
  }

  // Lyrics, comment consensus, current events and reply hooks (plan §6.2).
  // Video evidence wins: a lyric is kept when the merge rated it high, or
  // when it appears in the subtitles; comment events stay unverified.
  richFields(merged, watched) {
    const transcript = watched.flatMap((video) => video.observations.map((item) => item.transcript)).join(' ');
    const norm = (value) => String(value ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const insights = watched.map((video) => video.comments?.insight).filter(Boolean);
    const lyrics = [...merged.lyrics, ...insights.flatMap((insight) => insight.lyrics)]
      .filter((line) => line.confidence === 'high' || norm(transcript).includes(norm(line.line)))
      .filter((line, index, all) => all.findIndex((other) => norm(other.line) === norm(line.line)) === index)
      .slice(0, 8)
      .map((line) => ({ line: line.line, position: line.position || '', confidence: line.confidence }));
    const reception = insights.find((insight) => insight.reception?.summary)?.reception ?? null;
    const now = this.now();
    return {
      lyrics,
      reception: reception
        ? {
          sentiment: reception.sentiment,
          summary: reception.summary,
          phrases: reception.phrases.slice(0, 8),
          counterpoints: reception.counterpoints.slice(0, 4),
        }
        : {},
      currentEvents: insights.flatMap((insight) => commentEvents(insight, now))
        .map((event) => ({ ...event, expiresAt: now + this.comments.eventTtlMs }))
        .slice(0, 6),
      replyHooks: [...new Set([...merged.replyHooks, ...insights.flatMap((insight) => insight.replyHooks)])].slice(0, 6),
      content: { summary: merged.contentSummary, format: merged.format, people: merged.people },
      uncertainties: [...merged.uncertainties, ...insights.flatMap((insight) => insight.uncertainties)].slice(0, 6),
    };
  }


  async notifyWaiters(task, kind, entry) {
    const waiters = Array.isArray(task?.metadata?.waiters) ? task.metadata.waiters : [];
    const topic = entry?.term || task?.topic || '这个视频';
    for (const waiter of waiters) {
      let textValue = '';
      try {
        textValue = await this.composeReply(task, waiter, entry);
      } catch (error) {
        this.logger.warn?.(`视频学梗：生成回复失败：${error.message}`);
      }
      if (!textValue) {
        textValue = entry
          ? `查到了：${topic}，${entry.meaning}`.slice(0, 300)
          : `${topic} 我去看了一圈，还是没弄准，不瞎说了。`;
      }
      this.store.enqueueDelivery(task.taskKey, kind, {
        waiterKey: waiter.key,
        chatType: waiter.chatType,
        groupId: waiter.groupId,
        userId: waiter.userId,
        messageId: waiter.messageId,
        topic: task.topic,
        text: textValue,
      });
    }
  }

  async composeReply(task, waiter, entry) {
    const topic = entry?.term || task.topic;
    const question = waiter.question || task.question;
    const instruction = entry
      ? [
        '【本轮：查完梗回来回答】你之前说去 B 站看视频查这个梗，现在看完了，回到原问题。',
        memeKnowledgePrompt(entry, 'cache', { intent: memeReplyIntent(question, entry), now: this.now() }),
        `对方原话：${question}`,
        '按你的人设直接回答原问题，1～3 句。不要说“根据视频”“我看了几个视频”“评论区说”之类的过程，不要贴链接；还没确认的部分直接略过，不要提核实、音频或“别当定论”。',
      ]
      : [
        '【本轮：查梗没查到】你之前说去 B 站看视频查这个梗，结果没弄明白。',
        `梗：${topic}`,
        `对方原话：${waiter.question || task.question}`,
        '按你的人设回一句，说这个梗暂时没整明白、不瞎编，8～40 字。不要猜梗义，不要反问。',
      ];
    const answer = await this.chatClient.complete([], instruction.filter(Boolean).join('\n'), {
      prioritySystemPrompt: this.personaPrompt(waiter),
      maxTokens: 300,
      temperature: 0.8,
      timeoutMs: 60_000,
      thinking: { type: 'disabled' },
      usageSource: 'video-learning-reply',
    });
    return clean(answer, 600);
  }
}
