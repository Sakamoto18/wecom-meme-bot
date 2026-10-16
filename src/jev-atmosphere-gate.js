import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MODES = new Set(['auto', 'on', 'off', 'shadow']);
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

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
    if (quota || this.failureCount >= 3) {
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
    instructions: '当前内容是否需要核实近期热词、平台语境或具体文化出处？',
    criteria: {
      true: '存在明确且可能过时的文化线索、专有名词或需要出处核实的内容。',
      false: '已有知识或自然联想足够，联网只会增加噪音。',
    },
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
};

function answerNumber(answers, key) {
  const value = answers?.[key];
  if (typeof value === 'number') return clamp(value);
  return clamp(value?.noul ?? value?.probability ?? value?.yes ?? value?.true_probability);
}

export class JevAtmosphereGate {
  constructor(options = {}) {
    this.apiKey = String(options.apiKey ?? '').trim();
    this.baseUrl = String(options.baseUrl ?? 'https://api.typesafe.ai').trim().replace(/\/+$/, '');
    this.model = String(options.model ?? 'jev-1.13').trim();
    this.timeoutMs = Math.max(500, Number(options.timeoutMs ?? 2_500));
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
      const response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state: buildState(context),
          model: this.model,
          questions,
        }),
        signal: controller.signal,
      });
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok || !body?.answers) {
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
      return { ok: true, answers: body.answers, latencyMs };
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
        mode: ['banter', 'judgment', 'concise_answer', 'explanation', 'serious_support'].includes(mode)
          ? mode : 'concise_answer',
        memeFit: answerNumber(answers, 'meme_fit'),
        explanationNeeded: answerNumber(answers, 'explanation_needed'),
        cultureLookupNeeded: answerNumber(answers, 'culture_lookup_needed'),
        confidence: clamp(answers?.response_mode?.confidence, 0),
      };
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
    const response = await this.request(context, {
      meme_fit: QUESTIONS.meme_fit,
      explanation_needed: QUESTIONS.explanation_needed,
      culture_lookup_needed: QUESTIONS.culture_lookup_needed,
      response_mode: QUESTIONS.response_mode,
    }, 'jev-style');
    if (!response.ok) return { decision: 'fallback', reason: response.reason, style: null };
    const answers = response.answers;
    const mode = String(answers?.response_mode?.choice ?? answers?.response_mode?.value ?? '').trim();
    return {
      decision: 'allow',
      reason: 'jev-style',
      style: {
        mode: ['banter', 'judgment', 'concise_answer', 'explanation', 'serious_support'].includes(mode)
          ? mode : 'concise_answer',
        memeFit: answerNumber(answers, 'meme_fit'),
        explanationNeeded: answerNumber(answers, 'explanation_needed'),
        cultureLookupNeeded: answerNumber(answers, 'culture_lookup_needed'),
        confidence: clamp(answers?.response_mode?.confidence, 0),
      },
      latencyMs: response.latencyMs,
    };
  }
}

export function buildJevStylePrompt(style) {
  if (!style) return '';
  const mode = String(style.mode ?? '').trim();
  const lines = ['【本轮表达路由：仅供内部参考，不要向用户解释】'];
  if (mode === 'banter' && Number(style.memeFit) >= 0.65) {
    lines.push('当前适合自然接梗或抽象联想：先对事情下判断，再尝试一个具体画面、双关、转职或反差搭档。没有贴合落点就省略，不要硬塞。');
  } else if (mode === 'judgment') {
    lines.push('当前优先直接评价事情本身；可以带一层贴题语气，但不要退化成百科解释。');
  } else if (mode === 'explanation' || Number(style.explanationNeeded) >= 0.65) {
    lines.push('当前需要先把事实、条件或操作说准确；角色语气融进判断，不为了玩梗漏掉关键内容。');
  } else if (mode === 'serious_support') {
    lines.push('当前优先稳定、准确地回应现实处境；不要强行攻击、玩梗或把痛苦改写成段子。');
  } else {
    lines.push('当前直接接话即可；有具体贴合的联想再用，没有就简短回答。');
  }
  if (Number(style.cultureLookupNeeded) >= 0.8) {
    lines.push('如已有文化检索或缓存素材，只消化成自己的表达；不要播报搜索过程或来源列表。');
  }
  return lines.join('\n');
}
