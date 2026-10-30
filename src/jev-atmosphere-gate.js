import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCultureQualityPrompt } from './jev-culture-quality.js';

const MODES = new Set(['auto', 'on', 'off', 'shadow']);
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
const RESPONSE_MODES = new Set([
  'banter', 'judgment', 'concise_answer', 'explanation', 'serious_support',
  'culture', 'hybrid', 'serious', 'support',
]);
const CULTURE_DOMAINS = new Set(['longtu', 'general', 'platform', 'none']);
const PLATFORMS = new Set(['bilibili', 'xiaohongshu', 'douyin', 'weibo', 'tieba', 'general', 'unknown']);
const TONES = new Set(['dry', 'sarcastic', 'absurd', 'neutral']);
const TARGETS = new Set(['content', 'bot', 'third_party', 'unknown']);
const ATTACK_DECISIONS = new Set(['none', 'reply', 'target', 'mixed']);
const ATTACK_TARGETS = new Set([
  'bot', 'current_speaker', 'mentioned_member', 'quoted_author', 'content', 'uncertain',
]);
const ATTACK_ANGLES = new Set([
  'logic', 'behavior', 'attitude', 'contradiction', 'absurdity', 'family_meme', 'none',
]);
const ATTACK_TIMINGS = new Set(['before_answer', 'after_answer', 'standalone', 'none']);
const PROTOCOLS = new Set(['systemone', 'chat']);
const STANCES = new Set(['ironic', 'sarcastic', 'self_deprecating', 'absurd', 'serious', 'neutral', 'unknown']);
const INFORMATION_KINDS = new Set([
  'news', 'public_event', 'public_figure', 'technical_rule',
  'private_chat', 'reaction', 'unknown',
]);

function clamp(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function trimText(value, max = 2_000) {
  return String(value ?? '').trim().slice(-max);
}

function normalizeMode(value, fallback = 'off') {
  const mode = String(value ?? '').trim().toLowerCase();
  return MODES.has(mode) ? mode : fallback;
}

function normalizeProtocol(value, fallback = 'systemone') {
  const protocol = String(value ?? '').trim().toLowerCase();
  return PROTOCOLS.has(protocol) ? protocol : fallback;
}

function choice(value, allowed, fallback) {
  const candidate = String(value?.choice ?? value?.value ?? value ?? '').trim().toLowerCase();
  return allowed.has(candidate) ? candidate : fallback;
}

function listValue(value, limit = 8, itemLimit = 80) {
  const candidates = Array.isArray(value)
    ? value
    : (Array.isArray(value?.items) ? value.items
      : (Array.isArray(value?.values) ? value.values : []));
  return [...new Set(candidates.map((item) => String(item ?? '').trim().slice(0, itemLimit)).filter(Boolean))]
    .slice(0, limit);
}

function indexList(value, limit = 3) {
  const candidates = Array.isArray(value)
    ? value
    : (Array.isArray(value?.items) ? value.items : []);
  return [...new Set(candidates
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0))]
    .slice(0, limit);
}

function textValue(value, max = 500) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function associationList(value, limit = 2) {
  const candidates = Array.isArray(value)
    ? value
    : (Array.isArray(value?.items) ? value.items : []);
  return candidates.map((item) => {
    if (typeof item === 'string') return { idea: textValue(item, 180), whyFit: '', risk: '' };
    return {
      idea: textValue(item?.idea ?? item?.association ?? item?.text, 180),
      whyFit: textValue(item?.why_fit ?? item?.whyFit ?? item?.basis, 180),
      risk: textValue(item?.risk ?? item?.caveat, 140),
    };
  }).filter((item) => item.idea).slice(0, limit);
}

function contextTerms(context, domain) {
  const text = String([context?.currentMessage, context?.passiveImageText].filter(Boolean).join('\n'))
    .normalize('NFKC');
  const terms = text.match(/龙玉涛|龙图|龙图表情|龙图梗|杀妈|你妈|nm|nmb|mlgb|亡灵骑士|女鬼电梯|抽象|双关|谐音/giu) ?? [];
  if (domain === 'longtu' && terms.length === 0) terms.push('龙图');
  return [...new Set(terms)].slice(0, 8);
}

function explicitCultureQuestion(value = '') {
  return /(?:调侃|接梗|联想|玩梗|地狱笑话|网络梗|热梗|反差|暗示|讽刺|阴阳|锐评|抽象|双关|谐音|电竞梗)/iu.test(
    String(value ?? '').normalize('NFKC'),
  );
}

function errorText(error) {
  return String(error?.message ?? error ?? '').slice(0, 300);
}

export class JevRuntimeState {
  constructor(options = {}) {
    this.filePath = String(options.filePath ?? '').trim();
    this.defaultMode = normalizeMode(options.defaultMode, 'off');
    this.mode = this.defaultMode;
    this.circuitOpenUntil = 0;
    this.lastError = '';
    this.lastErrorAt = 0;
    this.failureCount = 0;
    this.cooldownMs = Math.max(10_000, Number(options.cooldownMs ?? DEFAULT_COOLDOWN_MS));
    // Transient upstream latency must not silence culture routing for an hour.
    // Quota/auth failures still open the circuit immediately; ordinary errors
    // need several consecutive failures before falling back globally.
    this.failureThreshold = Math.max(3, Number(options.failureThreshold ?? 6));
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  async load() {
    if (!this.filePath) return this;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        this.mode = normalizeMode(parsed.mode, this.defaultMode);
        this.circuitOpenUntil = Math.max(0, Number(parsed.circuitOpenUntil) || 0);
        this.lastError = String(parsed.lastError ?? '').slice(0, 300);
        this.lastErrorAt = Math.max(0, Number(parsed.lastErrorAt) || 0);
        this.failureCount = Math.max(0, Number(parsed.failureCount) || 0);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger.warn?.(`读取 Jev 运行状态失败：${errorText(error)}`);
    }
    return this;
  }

  isCircuitOpen() {
    if (this.circuitOpenUntil > this.now()) return true;
    if (this.circuitOpenUntil > 0) {
      this.circuitOpenUntil = 0;
      this.failureCount = 0;
    }
    return false;
  }

  effectiveMode() {
    if (this.mode === 'off') return 'off';
    return this.isCircuitOpen() ? 'fallback' : this.mode;
  }

  canCall() {
    return this.mode !== 'off' && !this.isCircuitOpen();
  }

  async persist() {
    if (!this.filePath) return;
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify({
      version: 1,
      mode: this.mode,
      circuitOpenUntil: this.circuitOpenUntil,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      failureCount: this.failureCount,
    }, null, 2)}\n`, 'utf8');
    await rename(temporary, this.filePath);
  }

  async setMode(mode) {
    const normalized = normalizeMode(mode, 'off');
    this.mode = normalized;
    this.circuitOpenUntil = 0;
    this.failureCount = 0;
    this.lastError = '';
    this.lastErrorAt = 0;
    await this.persist();
    return this.status();
  }

  async recordFailure(error, { quota = false } = {}) {
    this.failureCount += 1;
    this.lastError = errorText(error);
    this.lastErrorAt = this.now();
    if (quota || this.failureCount >= this.failureThreshold) {
      this.circuitOpenUntil = this.now() + this.cooldownMs;
    }
    await this.persist().catch((persistError) => {
      this.logger.warn?.(`保存 Jev 运行状态失败：${errorText(persistError)}`);
    });
  }

  async recordSuccess() {
    if (this.failureCount === 0 && this.circuitOpenUntil === 0) return;
    this.failureCount = 0;
    this.circuitOpenUntil = 0;
    this.lastError = '';
    this.lastErrorAt = 0;
    await this.persist().catch(() => {});
  }

  status() {
    return {
      mode: this.mode,
      effectiveMode: this.effectiveMode(),
      circuitOpen: this.isCircuitOpen(),
      circuitOpenUntil: this.circuitOpenUntil,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      failureCount: this.failureCount,
    };
  }
}

function isQuotaError(error, status) {
  const text = errorText(error).toLowerCase();
  return [401, 402, 403, 429].includes(Number(status))
    || /quota|credit|billing|rate.?limit|insufficient|exhaust|subscription|payment/.test(text);
}

function buildState(context = {}) {
  const contextImages = Array.isArray(context.contextImageCandidates)
    ? context.contextImageCandidates.slice(0, 6).map((item, index) => ({
      index: Number.isInteger(item?.index) && item.index > 0 ? item.index : index + 1,
      age_seconds: Math.max(0, Number(item?.ageSeconds) || 0),
      sender: String(item?.sender ?? '').slice(0, 40),
      label: String(item?.label ?? '').slice(0, 80),
      summary: String(item?.summary ?? '').slice(0, 500),
      has_raw_image: item?.hasRawImage === true,
    }))
    : [];
  const imageAnalysis = context.imageAnalysis && typeof context.imageAnalysis === 'object'
    ? {
      description: String(context.imageAnalysis.description ?? '').slice(0, 900),
      visible_text: Array.isArray(context.imageAnalysis.visibleText)
        ? context.imageAnalysis.visibleText.map((item) => String(item ?? '').slice(0, 100)).slice(0, 20)
        : [],
      keywords: Array.isArray(context.imageAnalysis.keywords)
        ? context.imageAnalysis.keywords.map((item) => String(item ?? '').slice(0, 80)).slice(0, 20)
        : [],
      scene_relation: String(context.imageAnalysis.sceneRelation ?? '').slice(0, 500),
      implied_point: String(context.imageAnalysis.impliedPoint ?? '').slice(0, 500),
      comic_mechanism: String(context.imageAnalysis.comicMechanism ?? '').slice(0, 400),
      visual_wordplay: String(context.imageAnalysis.visualWordplay ?? '').slice(0, 400),
      confidence: String(context.imageAnalysis.confidence ?? '').slice(0, 20),
      search_queries: Array.isArray(context.imageAnalysis.searchQueries)
        ? context.imageAnalysis.searchQueries.map((item) => String(item ?? '').slice(0, 140)).slice(0, 3)
        : [],
    }
    : null;
  return {
    transcript: trimText(context.transcript, 4_000),
    current_message: trimText(context.currentMessage, 1_200),
    conversation: {
      engagement: context.engagement === true,
      human_discussion: context.humanDiscussion === true,
      has_image_summary: Boolean(String(context.passiveImageText ?? '').trim()),
    },
    signals: context.signals ?? {},
    image_summary: trimText(context.passiveImageText, 1_200),
    image_analysis: imageAnalysis,
    raw_image: context.rawImageForJev === true,
    response_mode_state: context.responseModeState && typeof context.responseModeState === 'object'
      ? {
        mode: String(context.responseModeState.mode ?? '').trim(),
        remaining_turns: Math.max(0, Number(context.responseModeState.remainingTurns) || 0),
      }
      : null,
    context_images: contextImages,
  };
}

const QUESTIONS = {
  should_speak: {
    type: 'noul',
    instructions: '此刻机器人加入当前群聊是否自然，并且不会显得抢话？',
    criteria: {
      true: '当前消息仍有开放讨论、有效追问、纠正或自然的接话空间。',
      false: '消息只是附和、复读、私人交流、已结束问答或明显不需要机器人。',
    },
  },
  adds_value: {
    type: 'noul',
    instructions: '机器人现在是否能补充当前对话中尚未出现的有效内容？',
    criteria: {
      true: '能补充具体事实、办法、判断、反差或自然的接话落点。',
      false: '只能复述、泛泛评价、强行玩梗或重复群友已经说过的话。',
    },
  },
  would_interrupt: {
    type: 'noul',
    instructions: '机器人现在发言是否会明显打断群友或抢走当前话题？',
    criteria: {
      true: '群友之间的问答已经闭合、正在私聊，或机器人只能硬插一句。',
      false: '当前话题仍开放，机器人加入不会打断群友。',
    },
  },
  meme_fit: {
    type: 'noul',
    instructions: '当前内容是否存在一个具体、自然且能提升回复质量的互联网梗或抽象联想？',
    criteria: {
      true: '存在贴合当前动作、词语、关系或反差的具体联想，不需要硬套固定梗。',
      false: '只有空泛的“抽象/离谱”情绪，或者玩梗会损害事实准确性。',
    },
  },
  explanation_needed: {
    type: 'noul',
    instructions: '当前问题是否必须通过事实、原理、步骤或条件解释才能准确回答？',
  },
  culture_lookup_needed: {
    type: 'noul',
    instructions: '当前内容是否需要核实中文互联网语境、热梗、黑话、二创、平台话术或具体梗的来源？这里的“文化”只指互联网文化，不是现实文化、百科知识或泛泛背景介绍。',
    criteria: {
      true: '只有在梗义不明确、近期变化、用户问来源/出处/原帖，或需要核对专有名词时才为真。',
      false: '只是希望回复更像中文互联网、接梗或做抽象联想；风格需要不等于要联网。',
    },
  },
  fact_lookup_needed: {
    type: 'noul',
    instructions: '当前问题是否需要联网核实现实世界事实、出处、数据或原帖？与互联网梗无关的普通事实问题也算。',
    criteria: {
      true: '答案依赖可验证的外部事实、公开数据、人物/作品出处、时间线或原帖，而模型不能只凭可靠常识确认。',
      false: '普通闲聊、主观评价、创作类回答，或已有上下文足够且不需要外部证据。',
    },
  },
  time_sensitive: {
    type: 'noul',
    instructions: '答案是否依赖可能在模型训练数据截止之后变化的信息（现任、最新版本、价格、赛果、政策、今年发生的事）？',
    criteria: {
      true: '问题涉及“现在/今年/最新/最近”、会随时间变化的排名、版本、价格、政策、赛事或公众人物。',
      false: '稳定常识、历史事实、主观判断或与时间无关的语境。',
    },
  },
  culture_domain: {
    type: 'choice',
    instructions: '当前语境最接近哪个互联网语境？只有明确存在龙玉涛、龙图或相关古早互联网语境时才选 longtu；不要把现实文化、历史典故本身当作检索目标。',
    criteria: {
      longtu: '龙玉涛、龙图、龙图表情或其衍生语境。',
      general: '普通网络梗、热词、双关或互联网文化。',
      platform: '主要依赖某个平台的特殊语境。',
      none: '没有文化检索价值。',
    },
  },
  longtu_lookup_needed: {
    type: 'noul',
    instructions: '当前语境是否值得优先检索公开贴吧中的龙玉涛/龙图语境？',
    criteria: {
      true: '需要核对具体龙图梗义、古早用法、出处或容易误读的词族。',
      false: '现有上下文足够，检索只会增加噪音。',
    },
  },
  platform: {
    type: 'choice',
    instructions: '如果当前文化线索明显属于某个平台，选平台；否则选 unknown。',
    criteria: {
      bilibili: '哔哩哔哩语境。',
      xiaohongshu: '小红书语境。',
      douyin: '抖音语境。',
      weibo: '微博语境。',
      tieba: '百度贴吧语境。',
      general: '没有单一平台依赖。',
      unknown: '线索不足。',
    },
  },
  tone: {
    type: 'choice',
    instructions: '当前最自然的互联网表达气质是什么？',
    criteria: {
      dry: '干脆冷幽默。',
      sarcastic: '阴阳或讽刺。',
      absurd: '无厘头、反差或抽象联想。',
      neutral: '中性直接。',
    },
  },
  target: {
    type: 'choice',
    instructions: '当前回复主要针对什么对象？只判断语境，不授予攻击权限。',
    criteria: {
      content: '针对事情、图片、链接或观点。',
      bot: '针对机器人本身。',
      third_party: '明确针对其他第三方。',
      unknown: '对象不明确。',
    },
  },
  attack_decision: {
    type: 'choice',
    instructions: '当前是否存在真实的临场攻击语境？只判断当前消息和上下文，不因引用、图片、历史脏话或单个候选词自动攻击。',
    criteria: {
      none: '只是提问、转述、评价内容、引用材料或玩梗，没有对人回击授权。',
      reply: '当前发言者明确攻击机器人，机器人应直接回击。',
      target: '当前消息明确要求攻击某个第三方或明确指向某个成员。',
      mixed: '既需要回答问题，又明确攻击了机器人或指定对象，回答后还要回击。',
    },
  },
  attack_target: {
    type: 'choice',
    instructions: '如果确实需要攻击，明确攻击对象；如果对象不清楚必须选 uncertain。',
    criteria: {
      bot: '机器人本身是被攻击对象。',
      current_speaker: '当前发言者是明确的攻击对象。',
      mentioned_member: '本轮明确指定的被 @ 或被点名成员。',
      quoted_author: '当前用户明确要求攻击引用作者；引用作者只是来源时不能选此项。',
      content: '只批评事情、观点或行为，不做人身攻击。',
      uncertain: '无法安全确认攻击对象。',
    },
  },
  attack_intensity: {
    type: 'noul',
    instructions: '攻击语境成立时的自然强度。没有攻击授权必须为 0；明确辱骂机器人、直接要求加大火力，或说机器人攻击性弱/太软时，若对象和对线关系清楚通常取 0.8 到 1.0；不要把高压回击降成礼貌吐槽。',
  },
  attack_angle: {
    type: 'choice',
    instructions: '选择最贴合当前语境的攻击切入点；不要把 family_meme 当默认项。',
    criteria: {
      logic: '抓逻辑漏洞、偷换概念或答非所问。',
      behavior: '抓具体操作、行为或现场表现。',
      attitude: '抓装腔、嘴硬、摆谱或语气。',
      contradiction: '抓前后矛盾或自我打脸。',
      absurdity: '用当前语境的荒诞联想反击。',
      family_meme: '只有当前语境确实适合龙图亲属梗时才用。',
      none: '没有适合的人身攻击角度。',
    },
  },
  attack_timing: {
    type: 'choice',
    instructions: '如果同时存在问题和攻击，决定先后顺序。',
    criteria: {
      before_answer: '先短回击，再回答问题。',
      after_answer: '先回答问题，再补一句回击。',
      standalone: '只需要单独回击，不需要回答问题。',
      none: '不攻击。',
    },
  },
  answer_required: {
    type: 'noul',
    instructions: '当前是否仍有需要回答的事实问题或明确请求。',
  },
  target_confidence: {
    type: 'noul',
    instructions: '攻击对象判断的置信度；对象不清楚时必须较低。',
  },
  attack_reason: {
    type: 'text',
    instructions: '最多一句话说明攻击成立的具体语境依据，不生成攻击成品，不复述脏话。',
  },
  response_mode: {
    type: 'choice',
    instructions: '本轮回复最适合采用哪种表达模式？',
    criteria: {
      banter: '先接梗、具体联想或荒诞反差，再决定是否补事实。',
      judgment: '先对事情本身下一个明确判断或锐评。',
      concise_answer: '直接给简短答案，只保留必要信息。',
      explanation: '需要解释事实、原理、步骤、限制或方案。',
      serious_support: '涉及现实风险、痛苦、危机或敏感求助，应稳定认真回应。',
    },
  },
  culture_priority: {
    type: 'noul',
    instructions: '当前内容是否应该优先用中文互联网的接梗、黑话、二创、阴阳、抽象联想或反差来回答，而不是先做正经说明？这里的文化输出指互联网表达，不等于现实文化讲解。',
    criteria: {
      true: '非严肃问题中存在明确反差、二创、暗示、荒诞关系或可自然接住的文化落点。',
      false: '文化化表达会妨碍事实、步骤、核验或现实处境的准确回答。',
    },
  },
  internet_culture_priority: {
    type: 'noul',
    instructions: '当前回复是否应该优先采用中文互联网表达（接梗、黑话、二创、抽象联想、阴阳、地狱笑话、平台话术和反差），而不是百科式解释？这只决定输出风格，不代表需要联网。',
    criteria: {
      true: '当前有自然的互联网语境落点，能让回复像群友一样接住话题。',
      false: '当前需要准确事实、步骤、现实求助或没有贴合的互联网落点。',
    },
  },
  serious_request: {
    type: 'noul',
    instructions: '用户是否明确要求认真、具体、核验、方案、步骤，或连续纠正机器人答非所问？',
  },
  concrete_association: {
    type: 'noul',
    instructions: '是否存在一个具体且贴合当前画面/话题的联想落点，而不是泛泛说抽象、离谱或有意思？',
  },
  literal_reply_risk: {
    type: 'noul',
    instructions: '最终回复是否容易退化为复述图片或把搜索资料平铺出来，而没有回答真正的语境？',
  },
  image_culture_needed: {
    type: 'noul',
    instructions: '当前图片是否需要结合中文互联网文化、热梗、黑话、二创、双关、平台语境或出处才能理解其表达，而不是只描述画面？不要把现实文化背景或百科解释当成默认任务。',
    criteria: {
      true: '图片存在视觉双关、错视、网络梗、平台话术、隐晦反差或单靠字面/画面会误读。',
      false: '图片含义可以依据当前画面和文字直接回答，联网文化只会增加噪音。',
    },
  },
  image_fact_check_needed: {
    type: 'noul',
    instructions: '当前图片是否存在需要联网核实的公开事实、人物/作品出处、时间、数据或原帖信息？',
    criteria: {
      true: '图片提出明确事实主张、出处线索或可验证的公开事件，且模型不能只凭图可靠确认。',
      false: '没有明确公开事实，或当前问题只是评价/接梗，不应为了图片水印和泛泛关键词搜索。',
    },
  },
  image_complete_read_needed: {
    type: 'noul',
    instructions: 'DeepSeek 是否需要重新读取当前图片原图/全部切片，避免只依赖 OCR 或摘要？',
    criteria: {
      true: '图片有遮挡字、拆字、细小文字、多格关系、复杂构图、评论上下文或当前摘要明显不足。',
      false: '已有视觉资料足够，重新传原图不会增加判断价值。',
    },
  },
  visual_facts: {
    type: 'noul',
    instructions: '图片中最多六条可以由像素确认的事实，不写推测和文化解释。',
  },
  text_claims: {
    type: 'noul',
    instructions: '图片文字提出的主张，最多六条；它们不自动等于事实。',
  },
  semantic_relation: {
    type: 'noul',
    instructions: '一句话说明图片主体或事件之间正在发生什么关系。',
  },
  semantic_point: {
    type: 'noul',
    instructions: '一句话说明图片真正表达的观点、反差或笑点，不要复述画面。',
  },
  comic_mechanism: {
    type: 'noul',
    instructions: '指出错视、拆字、谐音、错位、反转、夸张、荒诞或讽刺等机制；没有证据就留空。',
  },
  stance: {
    type: 'choice',
    instructions: '图片表达的语气或立场。',
    criteria: {
      ironic: '反讽或表里不一。',
      sarcastic: '阴阳、嘲讽或挖苦。',
      self_deprecating: '自嘲。',
      absurd: '无厘头或荒诞。',
      serious: '认真陈述或求助。',
      neutral: '中性。',
      unknown: '无法判断。',
    },
  },
  literal_only_risk: {
    type: 'noul',
    instructions: '最终模型只描述图片字面、没有回答语义问题的风险。',
  },
  unknown_concept: {
    type: 'noul',
    instructions: '是否存在不应凭模型记忆确定的热词、梗义或平台语境。',
  },
  candidate_associations: {
    type: 'noul',
    instructions: '最多两个自然联想对象，每项包含 idea、why_fit、risk；没有贴合落点则为空。',
  },
  semantic_avoid_literal: {
    type: 'noul',
    instructions: '最终回答不应重复的表面描述，最多四条。',
  },
  semantic_confidence: {
    type: 'noul',
    instructions: '图片语用结论的整体置信度。',
  },
};

function answerNumber(answers, key) {
  const value = answers?.[key];
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return clamp(value);
  return clamp(value?.noul ?? value?.probability ?? value?.yes ?? value?.true_probability);
}

function booleanValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value >= 0.5;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'no', '0'].includes(normalized)) return false;
  return fallback;
}

function parseChatAnswers(content) {
  const text = String(content ?? '').trim();
  if (!text) return null;
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  const object = text.match(/\{[\s\S]*\}/u);
  if (object?.[0]) candidates.push(object[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // The model occasionally wraps JSON in one sentence; try the next form.
    }
  }
  return null;
}

const CHAT_GATE_SYSTEM_PROMPT = [
  '你是 QQ 群聊机器人的后台路由判断器，不负责写回复。',
  '请结合当前消息和最近上下文，判断是否值得机器人接话，以及是否需要联网核实中文互联网语境、热梗、黑话、二创、平台出处或龙图语境。这里的“文化层”专指中文互联网表达，不是现实文化背景或百科讲解。',
  '只输出一个合法 JSON 对象，不要 Markdown、解释、前后缀或换行外的文字。',
  '数值字段必须是 0 到 1 的数字；枚举字段必须使用给定值；query_terms 和 longtu_terms 必须是短词数组。',
  '图片语义必须分开写：visual_facts 是像素事实，text_claims 是图片文字主张，semantic_point 是图片真正表达的观点或反差；不要把图片描述当成语义结论。',
  '遇到“甲类全是X、乙类全是Y”或两句平行对照，必须先抽取两边的具体项目/群体和属性对应，判断并置后产生的黑色幽默、刻板印象借位或反差；semantic_relation、semantic_point、comic_mechanism、candidate_associations 都要落到这组具体关系，不能只返回“地狱/抽象/离谱/功德”。涉及种族、性别等敏感属性时只解释梗的结构与暗示，不把现实群体当攻击对象。',
  '如果 state.raw_image 存在，必须优先核对原图；如果视觉摘要和原图冲突，提高 image_complete_read_needed 或降低 semantic_confidence，不要迎合 OCR 猜测。',
  'candidate_associations 只返回最多两个有具体对应关系的联想；没有贴合落点就返回空数组，禁止用“抽象”“离谱”充数。',
  '除非用户明确要求认真、具体、核验或方案，否则非严肃语境优先判断是否应该采用中文互联网表达；serious_request 只在明确追问或连续纠正时提高。互联网表达只决定输出，不等于现实文化讲解或联网搜索。',
  'state.response_mode_state 是上一轮内部路由状态：如果 serious/support 仍有剩余轮次，除非当前消息明确回到文化闲聊，否则继续认真；culture 状态只提供倾向，不得阻止明确正经追问切换。',
  'state.context_images 是最近上下文图片候选。只有当前消息明确承接某张图片、引用其文字/画面，或不读图就无法判断时，才把 context_image_needed 设为较高，并返回对应编号；泛泛发图、旧图片或只凭文字就能回答时必须返回空数组。',
  'context_image_indexes 只能填写 state.context_images 中已有的正整数编号，最多 3 个；不要臆造编号，也不要输出图片本身。',
  'state.image_analysis 是当前图片的低可信视觉/OCR摘要。它不是结论：如果摘要与问题、画面关系或上下文不一致，优先提高 image_complete_read_needed，让最终模型重新看原图；不要只因有水印、账号名或一个热词就触发搜索。',
  '攻击策略必须单独判断：先分清当前发言者是在骂机器人、要求攻击第三方、讨论/引用脏话，还是只评价事情。attack_decision=none 时不得启动临场人身攻击；attack_target 只能指向已确认对象，不能把引用作者、图片人物或历史对话自动当成当前目标。Jev 只返回策略，不写攻击成品；最终语气由 DeepSeek 结合策略和上下文生成。',
  '电竞截图、评论区和地狱笑话可能借用“父亲、死亡、夺冠、皮肤”等敏感词制造互联网暗示；除非有独立公开证据，不得把玩笑里的家庭变故或人物经历当成事实。应把它标为图片文字主张/梗的设定，并优先核实“选手+独特台词/皮肤名”的网络语境。',
  JSON.stringify({
    should_speak: 'number: 机器人现在自然插话的概率',
    adds_value: 'number: 能补充当前对话尚未出现的有效内容的概率',
    would_interrupt: 'number: 发言会打断群友或抢话的概率',
    meme_fit: 'number: 存在贴合当前语境的具体网络梗/反差联想的概率',
    explanation_needed: 'number: 必须解释事实、原理或步骤的概率',
    culture_lookup_needed: 'number: 需要联网核实互联网文化语境的概率',
    fact_lookup_needed: 'number: 需要联网核实现实世界事实、出处、数据或原帖的概率；与互联网梗无关的普通事实问题也算',
    time_sensitive: 'number: 答案依赖可能在模型训练数据截止之后变化的信息的概率',
    culture_domain: 'longtu|general|platform|none',
    longtu_lookup_needed: 'number: 值得检索贴吧中的龙玉涛/龙图语境的概率',
    platform: 'bilibili|xiaohongshu|douyin|weibo|tieba|general|unknown',
    tone: 'dry|sarcastic|absurd|neutral',
    target: 'content|bot|third_party|unknown',
    attack_decision: 'none|reply|target|mixed',
    attack_target: 'bot|current_speaker|mentioned_member|quoted_author|content|uncertain',
    attack_intensity: 'number: 0 到 1，攻击强度；无攻击时为 0',
    attack_angle: 'logic|behavior|attitude|contradiction|absurdity|family_meme|none',
    attack_timing: 'before_answer|after_answer|standalone|none',
    answer_required: 'number: 当前是否仍需回答问题',
    target_confidence: 'number: 攻击对象判断置信度',
    attack_reason: '一句话说明攻击成立的具体语境依据，不生成成品',
    response_mode: 'culture|hybrid|serious|support|banter|judgment|concise_answer|explanation|serious_support',
    culture_priority: 'number: 是否优先文化输出和具体接梗',
    internet_culture_priority: 'number: 是否优先中文互联网表达；只决定输出风格，不代表需要联网',
    serious_request: 'number: 用户要求正经回答或连续纠正的概率',
    concrete_association: 'number: 存在具体贴题联想落点的概率',
    literal_reply_risk: 'number: 最终回答退化成字面复述的风险',
    context_image_needed: 'number: 是否需要读取最近上下文中的某张图片才能准确接话',
    context_image_indexes: '最多 3 个正整数，对应 state.context_images 中需要读取的图片编号；不需要则为空数组',
    context_image_reason: '短句说明为什么需要这些图片；不需要则为空字符串',
    image_culture_needed: 'number: 当前图片是否需要中文互联网文化/梗语境才能正确理解',
    image_fact_check_needed: 'number: 当前图片是否需要联网核实公开事实、出处或原帖',
    image_complete_read_needed: 'number: 是否需要 DeepSeek 重新读取原图/全部切片，而不是只依赖 OCR 摘要',
    image_query_terms: '最多 4 个从图片可见内容中提取的具体文化/事实核验短词',
    grounding_needed: 'number: 回答必须依赖现实新闻、公开事件、真实人物/产品、技术规则或数字合法性，仅凭常识可能答错的概率',
    reality_anchor_hint: '一句话写图片/对话指向的现实事件、主体或规则；纯表情/反应图/无公共锚点则空字符串',
    grounding_query_terms: '最多 4 个把当前用户提示和现实锚点合起来的事实检索短词；没有具体锚点则为空数组',
    information_kind: 'news|public_event|public_figure|technical_rule|private_chat|reaction|unknown',
    visual_facts: '最多 6 条只由图片像素确认的事实',
    text_claims: '最多 6 条图片文字提出的主张，不等于事实',
    semantic_relation: '一句话说明主体/事件之间正在发生什么关系',
    semantic_point: '一句话说明图片真正表达的观点、反差或笑点，不要复述画面',
    comic_mechanism: '错视|拆字|谐音|错位|反转|夸张|荒诞|讽刺|其他；可附一句说明',
    stance: 'ironic|sarcastic|self_deprecating|absurd|serious|neutral|unknown',
    literal_only_risk: 'number: 最终模型只复述图片字面而不回答语义的风险',
    unknown_concept: 'boolean: 是否存在模型不应凭记忆确定的热词/梗/平台语境',
    candidate_associations: '最多 2 个对象，字段为 idea、why_fit、risk；没有可靠联想则为空数组',
    semantic_avoid_literal: '最多 4 条最终回答不要重复的表面描述',
    semantic_confidence: 'number: 图片语用结论的整体置信度',
    query_terms: '最多 8 个用于文化检索的短词',
    longtu_terms: '最多 8 个用于贴吧检索的短词',
  }),
].join('\n');

function normalizeCultureAnswers(answers, context = {}) {
  const domain = choice(answers?.culture_domain, CULTURE_DOMAINS, 'none');
  const platform = choice(answers?.platform, PLATFORMS, 'unknown');
  const tone = choice(answers?.tone, TONES, 'neutral');
  const target = choice(answers?.target, TARGETS, 'unknown');
  const lookupNeeded = answerNumber(answers, 'culture_lookup_needed');
  const longtuLookupNeeded = answerNumber(answers, 'longtu_lookup_needed');
  const factLookupNeeded = answerNumber(answers, 'fact_lookup_needed');
  const timeSensitive = answerNumber(answers, 'time_sensitive');
  const retrievalNeeded = Math.max(lookupNeeded, longtuLookupNeeded);
  const terms = listValue(answers?.query_terms ?? answers?.culture_terms);
  const longtuTerms = listValue(answers?.longtu_terms);
  const derivedTerms = contextTerms(context, domain);
  const availableImageIndexes = new Set(
    (context.contextImageCandidates ?? [])
      .map((item, index) => Number.isInteger(item?.index) && item.index > 0 ? item.index : index + 1),
  );
  const contextImageIndexes = indexList(answers?.context_image_indexes)
    .filter((index) => availableImageIndexes.has(index));
  const imageQueryTerms = listValue(answers?.image_query_terms, 4, 140);
  const groundingQueryTerms = listValue(answers?.grounding_query_terms, 4, 140);
  const realityAnchorHint = textValue(answers?.reality_anchor_hint, 220);
  const informationKind = choice(answers?.information_kind, INFORMATION_KINDS, 'unknown');
  const pragmatic = answers?.pragmatic && typeof answers.pragmatic === 'object'
    ? answers.pragmatic : {};
  const culture = answers?.culture && typeof answers.culture === 'object'
    ? answers.culture : {};
  const guidance = answers?.reply_guidance && typeof answers.reply_guidance === 'object'
    ? answers.reply_guidance : {};
  const semanticPoint = textValue(
    answers?.semantic_point ?? pragmatic.actual_point ?? pragmatic.semantic_point,
    500,
  );
  const semanticRelation = textValue(
    answers?.semantic_relation ?? pragmatic.scene_relation ?? pragmatic.relation,
    400,
  );
  const semanticMechanism = textValue(
    answers?.comic_mechanism ?? pragmatic.comic_mechanism,
    240,
  );
  const stanceValue = choice(
    answers?.stance ?? pragmatic.stance,
    STANCES,
    'unknown',
  );
  const associations = associationList(
    answers?.candidate_associations ?? guidance.candidate_associations,
  );
  const semanticAvoidLiteral = listValue(
    answers?.semantic_avoid_literal ?? guidance.avoid_literal_repetition,
    4,
    160,
  );
  const attack = answers?.attack && typeof answers.attack === 'object' ? answers.attack : {};
  const attackDecision = choice(
    answers?.attack_decision ?? attack.decision,
    ATTACK_DECISIONS,
    'none',
  );
  const attackTarget = choice(
    answers?.attack_target ?? attack.target,
    ATTACK_TARGETS,
    'uncertain',
  );
  const attackAngle = choice(
    answers?.attack_angle ?? attack.angle,
    ATTACK_ANGLES,
    'none',
  );
  const attackTiming = choice(
    answers?.attack_timing ?? attack.timing,
    ATTACK_TIMINGS,
    attackDecision === 'none' ? 'none' : 'standalone',
  );
  return {
    cultureDomain: domain,
    platform,
    tone,
    target,
    cultureLookupNeeded: lookupNeeded,
    factLookupNeeded,
    timeSensitive,
    longtuLookupNeeded,
    retrievalNeeded,
    queryTerms: [...new Set([...terms, ...derivedTerms])].slice(0, 8),
    longtuTerms: [...new Set([...longtuTerms, ...(domain === 'longtu' ? derivedTerms : [])])].slice(0, 8),
    associationAngles: listValue(answers?.association_angles),
    contextImageNeeded: answerNumber(answers, 'context_image_needed'),
    contextImageIndexes,
    contextImageReason: String(answers?.context_image_reason ?? '').trim().slice(0, 240),
    imageCultureNeeded: answerNumber(answers, 'image_culture_needed'),
    imageFactCheckNeeded: answerNumber(answers, 'image_fact_check_needed'),
    imageCompleteReadingNeeded: answerNumber(answers, 'image_complete_read_needed'),
    imageQueryTerms,
    groundingNeeded: answerNumber(answers, 'grounding_needed'),
    realityAnchorHint,
    groundingQueryTerms,
    informationKind,
    visualFacts: listValue(answers?.visual_facts ?? pragmatic.visual_facts, 6, 180),
    textClaims: listValue(answers?.text_claims ?? pragmatic.text_claims, 6, 180),
    semanticRelation,
    semanticPoint,
    semanticMechanism,
    stance: stanceValue,
    literalOnlyRisk: answerNumber(
      answers,
      'literal_only_risk',
    ) || answerNumber(pragmatic, 'literal_only_risk'),
    unknownConcept: booleanValue(
      answers?.unknown_concept ?? culture.unknown_concept,
    ),
    associationCandidates: associations,
    semanticAvoidLiteral,
    semanticConfidence: answerNumber(
      answers,
      'semantic_confidence',
    ) || answerNumber(pragmatic, 'semantic_confidence'),
    culturePriority: answerNumber(answers, 'internet_culture_priority')
      || answerNumber(answers, 'culture_priority')
      || answerNumber(culture, 'culture_priority'),
    seriousRequest: answerNumber(answers, 'serious_request')
      || answerNumber(culture, 'serious_request'),
    concreteAssociation: answerNumber(answers, 'concrete_association')
      || answerNumber(pragmatic, 'concrete_association'),
    literalReplyRisk: answerNumber(answers, 'literal_reply_risk')
      || answerNumber(guidance, 'literal_reply_risk'),
    confidence: clamp(answers?.culture_domain?.confidence ?? answers?.confidence, 0),
    attackStrategy: {
      decision: attackDecision,
      target: attackTarget,
      intensity: answerNumber(answers, 'attack_intensity') || answerNumber(attack, 'intensity'),
      angle: attackAngle,
      timing: attackTiming,
      answerRequired: answerNumber(answers, 'answer_required') || answerNumber(attack, 'answer_required'),
      targetConfidence: answerNumber(answers, 'target_confidence') || answerNumber(attack, 'target_confidence'),
      reason: textValue(answers?.attack_reason ?? attack.reason, 220),
    },
  };
}

export class JevAtmosphereGate {
  constructor(options = {}) {
    this.apiKey = String(options.apiKey ?? '').trim();
    this.baseUrl = String(options.baseUrl ?? 'https://api.typesafe.ai').trim().replace(/\/+$/, '');
    this.model = String(options.model ?? 'qwen3.7-plus').trim();
    this.protocol = normalizeProtocol(options.protocol, 'systemone');
    // The router returns image semantics, search terms and mode fields in one
    // The router returns image semantics, search terms and mode fields in one
    // JSON object. A 700-token cap truncates qwen3.7-plus halfway through the
    // object (HTTP 200 + finish_reason=length), which looks like a provider
    // failure and silently disables the culture route. Output is free on the
    // configured Jev plan, so leave enough room for the schema to close.
    this.chatMaxTokens = Math.max(400, Number(options.chatMaxTokens ?? 1_800));
    // qwen3.7-plus may spend several seconds producing the structured image
    // route. A short timeout silently removes semantic routing and makes the
    // final model fall back to OCR-only answers. The deployment can override
    // this, but the safe default is deliberately generous.
    this.timeoutMs = Math.max(500, Number(options.timeoutMs ?? 30_000));
    this.allowThreshold = clamp(options.allowThreshold, 0.72);
    this.skipThreshold = clamp(options.skipThreshold, 0.28);
    this.runtime = options.runtime ?? new JevRuntimeState({ defaultMode: 'off' });
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger ?? console;
    this.onUsage = options.onUsage;
  }

  get isConfigured() {
    return Boolean(this.apiKey && this.baseUrl && this.model && this.fetchImpl);
  }

  getStatus() {
    return {
      configured: this.isConfigured,
      model: this.model,
      protocol: this.protocol,
      ...this.runtime.status(),
    };
  }

  async setMode(mode) {
    return this.runtime.setMode(mode);
  }

  async request(context, questions, source = 'jev-atmosphere') {
    if (!this.isConfigured || !this.runtime.canCall()) {
      return { ok: false, reason: this.isConfigured ? 'jev-disabled-or-circuit' : 'jev-unconfigured' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      const isChat = this.protocol === 'chat';
      const response = await this.fetchImpl(
        `${this.baseUrl}/v1/${isChat ? 'chat/completions' : 'systemone'}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(isChat
            ? {
              model: this.model,
              messages: [
                { role: 'system', content: CHAT_GATE_SYSTEM_PROMPT },
                {
                  role: 'user',
                  content: context.rawImageForJev && Array.isArray(context.rawImageBlocks)
                    ? [
                      {
                        type: 'text',
                        text: [
                          '请只返回 JSON 判断结果。',
                          JSON.stringify({ state: buildState(context), requested_fields: questions }),
                        ].join('\n'),
                      },
                      ...context.rawImageBlocks
                        .filter((block) => block?.type === 'image_url')
                        .slice(0, 2),
                    ]
                    : [
                      '请只返回 JSON 判断结果。',
                      JSON.stringify({ state: buildState(context), requested_fields: questions }),
                    ].join('\n'),
                },
              ],
              temperature: 0,
              max_tokens: this.chatMaxTokens,
              // Jev is a high-frequency router, not the final answer model.
              // Disable Qwen's long reasoning chain so a gate does not add
              // several seconds of latency or consume answer-model budget.
              enable_thinking: false,
              response_format: { type: 'json_object' },
            }
            : {
              state: buildState(context),
              model: this.model,
              questions,
            }),
          signal: controller.signal,
        },
      );
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      const answers = isChat
        ? parseChatAnswers(body?.choices?.[0]?.message?.content)
        : body?.answers;
      if (!response.ok || !answers) {
        const message = body?.error?.message || `HTTP ${response.status}`;
        const error = new Error(`Jev 请求失败：${message}`);
        error.status = response.status;
        const latencyMs = Date.now() - startedAt;
        try {
          this.onUsage?.({
            source,
            model: body?.model || this.model,
            usage: body?.usage ?? null,
            succeeded: false,
            status: response.status,
            error: errorText(error),
            latencyMs,
          });
        } catch (usageError) {
          this.logger.warn?.(`记录 Jev 用量失败：${errorText(usageError)}`);
        }
        const quota = isQuotaError(error, response.status);
        await this.runtime.recordFailure(error, { quota });
        return { ok: false, reason: quota ? 'jev-quota' : 'jev-error', latencyMs };
      }
      await this.runtime.recordSuccess();
      const latencyMs = Date.now() - startedAt;
      try {
        this.onUsage?.({
          source,
          model: body.model || this.model,
          usage: body.usage ?? null,
          succeeded: true,
          status: response.status,
          latencyMs,
        });
      } catch (usageError) {
        this.logger.warn?.(`记录 Jev 用量失败：${errorText(usageError)}`);
      }
      return { ok: true, answers, latencyMs };
    } catch (error) {
      const quota = isQuotaError(error);
      const latencyMs = Date.now() - startedAt;
      try {
        this.onUsage?.({
          source,
          model: this.model,
          usage: null,
          succeeded: false,
          status: Number(error?.status) || 0,
          error: errorText(error),
          latencyMs,
        });
      } catch (usageError) {
        this.logger.warn?.(`记录 Jev 用量失败：${errorText(usageError)}`);
      }
      await this.runtime.recordFailure(error, { quota });
      this.logger.warn?.(`Jev 判定失败，回退当前链路：${errorText(error)}`);
      return { ok: false, reason: quota ? 'jev-quota' : 'jev-error', latencyMs };
    } finally {
      clearTimeout(timer);
    }
  }

  async evaluate(context = {}) {
    const response = await this.request(context, QUESTIONS, 'jev-atmosphere');
    if (!response.ok) {
      return { decision: 'fallback', reason: response.reason, style: null, latencyMs: response.latencyMs };
    }
    try {
      const { answers } = response;
      const shouldSpeak = answerNumber(answers, 'should_speak');
      const addsValue = answerNumber(answers, 'adds_value');
      const wouldInterrupt = answerNumber(answers, 'would_interrupt');
      const probability = Math.min(shouldSpeak, addsValue, 1 - wouldInterrupt);
      const mode = String(answers?.response_mode?.choice ?? answers?.response_mode?.value ?? '').trim();
      const style = {
        mode: RESPONSE_MODES.has(mode) ? mode : 'concise_answer',
        memeFit: answerNumber(answers, 'meme_fit'),
        explanationNeeded: answerNumber(answers, 'explanation_needed'),
        cultureLookupNeeded: answerNumber(answers, 'culture_lookup_needed'),
        confidence: clamp(answers?.response_mode?.confidence, 0),
        ...normalizeCultureAnswers(answers, context),
        // Chat-model Jev is a router only. Its culture fields may drive search,
        // but never rewrite the existing DeepSeek persona prompt.
        promptEnabled: true,
      };
      if (explicitCultureQuestion(context.currentMessage)
        && Number(style.seriousRequest) < 0.6
        && (Number(style.memeFit) >= 0.45 || Number(style.imageCultureNeeded) >= 0.65)) {
        style.mode = 'culture';
      }
      const decision = probability >= this.allowThreshold
        ? 'allow' : probability <= this.skipThreshold ? 'skip' : 'fallback';
      return {
        decision,
        probability,
        factors: { shouldSpeak, addsValue, wouldInterrupt },
        style,
        reason: `jev-${decision}`,
        latencyMs: response.latencyMs,
      };
    } catch (error) {
      return { decision: 'fallback', reason: 'jev-invalid-response', style: null, latencyMs: response.latencyMs };
    }
  }

  async evaluateStyle(context = {}) {
    // Keep one structured request for style, culture and retrieval routing.
    // The caller can reuse the returned object for both prompt routing and
    // the longtu/贴吧 lookup; no second Jev call is needed for the same turn.
    const response = await this.request(context, {
      meme_fit: QUESTIONS.meme_fit,
      explanation_needed: QUESTIONS.explanation_needed,
      culture_lookup_needed: QUESTIONS.culture_lookup_needed,
      fact_lookup_needed: QUESTIONS.fact_lookup_needed,
      time_sensitive: QUESTIONS.time_sensitive,
      culture_domain: QUESTIONS.culture_domain,
      longtu_lookup_needed: QUESTIONS.longtu_lookup_needed,
      platform: QUESTIONS.platform,
      tone: QUESTIONS.tone,
      target: QUESTIONS.target,
      attack_decision: QUESTIONS.attack_decision,
      attack_target: QUESTIONS.attack_target,
      attack_intensity: QUESTIONS.attack_intensity,
      attack_angle: QUESTIONS.attack_angle,
      attack_timing: QUESTIONS.attack_timing,
      answer_required: QUESTIONS.answer_required,
      target_confidence: QUESTIONS.target_confidence,
      attack_reason: QUESTIONS.attack_reason,
      response_mode: QUESTIONS.response_mode,
      context_image_needed: QUESTIONS.context_image_needed,
      context_image_indexes: QUESTIONS.context_image_indexes,
      context_image_reason: QUESTIONS.context_image_reason,
      image_culture_needed: QUESTIONS.image_culture_needed,
      image_fact_check_needed: QUESTIONS.image_fact_check_needed,
      image_complete_read_needed: QUESTIONS.image_complete_read_needed,
      image_query_terms: QUESTIONS.image_query_terms,
      grounding_needed: QUESTIONS.grounding_needed,
      reality_anchor_hint: QUESTIONS.reality_anchor_hint,
      grounding_query_terms: QUESTIONS.grounding_query_terms,
      information_kind: QUESTIONS.information_kind,
      visual_facts: QUESTIONS.visual_facts,
      text_claims: QUESTIONS.text_claims,
      semantic_relation: QUESTIONS.semantic_relation,
      semantic_point: QUESTIONS.semantic_point,
      comic_mechanism: QUESTIONS.comic_mechanism,
      stance: QUESTIONS.stance,
      literal_only_risk: QUESTIONS.literal_only_risk,
      unknown_concept: QUESTIONS.unknown_concept,
      candidate_associations: QUESTIONS.candidate_associations,
      semantic_avoid_literal: QUESTIONS.semantic_avoid_literal,
      semantic_confidence: QUESTIONS.semantic_confidence,
      culture_priority: QUESTIONS.culture_priority,
      internet_culture_priority: QUESTIONS.internet_culture_priority,
      serious_request: QUESTIONS.serious_request,
      concrete_association: QUESTIONS.concrete_association,
      literal_reply_risk: QUESTIONS.literal_reply_risk,
    }, 'jev-style');
    if (!response.ok) return { decision: 'fallback', reason: response.reason, style: null };
    const answers = response.answers;
    const mode = String(answers?.response_mode?.choice ?? answers?.response_mode?.value ?? '').trim();
    const style = {
      mode: RESPONSE_MODES.has(mode) ? mode : 'concise_answer',
      memeFit: answerNumber(answers, 'meme_fit'),
      explanationNeeded: answerNumber(answers, 'explanation_needed'),
      cultureLookupNeeded: answerNumber(answers, 'culture_lookup_needed'),
      confidence: clamp(answers?.response_mode?.confidence, 0),
      ...normalizeCultureAnswers(answers, context),
      promptEnabled: true,
    };
    if (explicitCultureQuestion(context.currentMessage)
      && Number(style.seriousRequest) < 0.6
      && (Number(style.memeFit) >= 0.45 || Number(style.imageCultureNeeded) >= 0.65)) {
      style.mode = 'culture';
    }
    return {
      decision: 'allow',
      reason: 'jev-style',
      style,
      latencyMs: response.latencyMs,
    };
  }
}

export function buildJevStylePrompt(style) {
  if (!style) return '';
  const mode = String(style.mode ?? '').trim();
  const lines = [];
  // Chat Jev is still forbidden from rewriting the persona. The image
  // routing notes below are evidence-handling instructions, not style control.
  if (style.promptEnabled !== false) {
    lines.push('【本轮表达路由：仅供内部参考，不要向用户解释】');
    if (mode === 'culture' || (mode === 'banter' && Number(style.memeFit) >= 0.45)) {
      lines.push('当前互联网语境优先：先抓住具体关系、反差、黑话、二创或暗示，直接给一个贴题联想；不要先复述图片或把回复写成现实文化说明文。没有可靠落点时收短，不要硬编。这个路由只改变输出味道，不要求联网。');
    } else if (mode === 'banter' && Number(style.memeFit) >= 0.65) {
      lines.push('当前适合自然接梗或抽象联想：先对事情下判断，再尝试一个具体画面、双关、转职或反差搭档。没有贴合落点就省略，不要硬塞。');
    } else if (mode === 'hybrid' || mode === 'judgment') {
      lines.push('当前先用一句具体语气接住事情，再补必要结论；不要把整段回复写成百科解释。');
    } else if (mode === 'serious' || mode === 'explanation' || Number(style.explanationNeeded) >= 0.65) {
      lines.push('当前需要先把事实、条件或操作说准确；角色语气融进判断，不为了玩梗漏掉关键内容。');
    } else if (mode === 'support' || mode === 'serious_support') {
      lines.push('当前优先稳定、准确地回应现实处境；不要强行攻击、玩梗或把痛苦改写成段子。');
    } else {
      lines.push('当前直接接话即可；有具体贴合的联想再用，没有就简短回答。');
    }
    if (mode === 'culture' || mode === 'hybrid' || mode === 'banter') {
      lines.push(buildCultureQualityPrompt(style));
    }
    if (Number(style.cultureLookupNeeded) >= 0.8) {
      lines.push('如已有互联网梗检索或缓存素材，只消化成自己的表达；不要播报搜索过程或来源列表，也不要把结果写成百科背景介绍。没有检索素材也可以直接用当前语境做互联网联想。');
    }
    if (style.cultureDomain === 'longtu' || Number(style.longtuLookupNeeded) >= 0.7) {
      lines.push('当前可能涉及龙玉涛/龙图语境：优先把具体词语、画面关系和反差接起来；若后台有贴吧短卡，只把核验后的语境自然融入，不要把贴吧内容当现实人物事实，也不要照抄攻击性话术。');
    }
  }
  if (Number(style.imageCompleteReadingNeeded) >= 0.7) {
    lines.push('【图片完整核对】不要只依赖 OCR 或摘要；重新读取当前图片原图/全部切片，核对遮挡字、细小文字、主体关系和整张图的反差后再回答。');
  }
  if (Number(style.imageCultureNeeded) >= 0.65) {
    lines.push('【图片互联网语境】如果图中存在双关、错视、热梗、黑话、二创或平台话术，先把画面关系和字面主张分开，再把核验后的网络梗义自然接入回答；没有贴合证据不要硬套梗，也不要转成现实文化科普。');
    lines.push('【图片文化输出优先】本轮默认是互联网接梗，不做正经逻辑拆解或道德说教。第一句必须落到图片里的具体并置关系、反差对象或暗示机制；不能只回一个情绪标签，也不能只说“地狱、功德、抽象、离谱、幸存者偏差”等泛标签。可以点出这是把两个项目/群体并排后借刻板印象制造黑色幽默，但不要继续扩写成针对现实群体的侮辱。除非用户明确追问事实真伪、原因或背景，否则不要补正经解释。');
  }
  if (Number(style.imageCultureNeeded) >= 0.55
    || (Number(style.culturePriority) >= 0.75 && ['culture', 'hybrid', 'banter', 'judgment'].includes(mode))) {
    lines.push('【图片接梗硬约束】本轮图片已经有互联网语境价值。第一句直接给针对事情的判断、反差或群友式联想；禁止复述截图标题、榜单、评论和用户问题，禁止用“热搜说/图里写着/截图显示”起手。需要事实时第二句只补改变结论的一点。');
  }
  if (Number(style.imageFactCheckNeeded) >= 0.65) {
    lines.push('【图片事实核验】图片中的人物、出处、时间、数据和原帖只当待核实线索；优先使用后台核验结果，匹配不足就保留不确定性，不要把截图主张当事实。');
  }
  return lines.join('\n');
}

export function buildJevSemanticPrompt(style) {
  if (!style || typeof style !== 'object') return '';
  const point = textValue(style.semanticPoint, 500);
  const relation = textValue(style.semanticRelation, 400);
  const mechanism = textValue(style.semanticMechanism, 240);
  const associations = associationList(style.associationCandidates);
  const avoid = listValue(style.semanticAvoidLiteral, 4, 160);
  const hasSemantic = point || relation || mechanism || associations.length > 0 || avoid.length > 0;
  if (!hasSemantic) return '';
  const lines = [
    '【Jev 图片语用候选；只作内部证据，不是最终答案】',
    relation ? `主体关系：${relation}` : '',
    point ? `图片表达重点：${point}` : '',
    mechanism ? `可能的表达机制：${mechanism}` : '',
    associations.length > 0
      ? `可考虑的自然联想：${associations.map((item) => `${item.idea}${item.whyFit ? `（${item.whyFit}）` : ''}`).join('；')}`
      : '',
    avoid.length > 0 ? `不要只重复这些表面内容：${avoid.join('；')}` : '',
    Number(style.literalOnlyRisk) >= 0.55
      ? '本轮容易退化成图片描述；若用户问的是含义、评价或梗义，必须先回答关系、观点或反差。'
      : '',
    Number(style.imageCultureNeeded) >= 0.65
      ? '图片文化模式的具体落点：回复至少要使用语义候选中的一个具体关系（例如“项目A↔项目B、属性X↔属性Y”或同等明确的并置关系），不能只回一个情绪标签。'
      : '',
    Number(style.semanticConfidence) > 0 && Number(style.semanticConfidence) < 0.55
      ? '语义候选置信度有限，必须回到原图核对；不成立就舍弃。宁可只说像素能确认的部分，也不要把低置信推断写成结论。'
      : '',
  ].filter(Boolean);
  return lines.join('\n');
}
