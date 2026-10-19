const RESPONSE_MODES = new Set(['culture', 'hybrid', 'serious', 'support']);

function score(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function text(value, max = 240) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

export function culturePriority(style = {}) {
  return Math.max(
    score(style.culturePriority),
    score(style.memeFit),
    score(style.imageCultureNeeded),
    style.semanticPoint ? Math.min(1, score(style.semanticConfidence) + 0.2) : 0,
    Array.isArray(style.associationCandidates) && style.associationCandidates.length > 0 ? 0.65 : 0,
  );
}

export function seriousPriority(style = {}) {
  return Math.max(
    score(style.seriousRequest),
    score(style.explanationNeeded),
    String(style.mode ?? '').trim() === 'serious_support' ? 1 : 0,
    String(style.mode ?? '').trim() === 'explanation' ? 0.8 : 0,
  );
}

export function resolveJevResponseMode(style = {}, previous = null, options = {}) {
  const cultureDefault = options.cultureDefault !== false;
  const cultureMinScore = score(options.cultureMinScore ?? 0.45);
  const previousMode = RESPONSE_MODES.has(previous?.mode) ? previous.mode : '';
  const previousTurns = Math.max(0, Number(previous?.remainingTurns) || 0);
  const cultureScore = culturePriority(style);
  const seriousScore = seriousPriority(style);
  const modelMode = String(style.responseMode ?? style.mode ?? '').trim();

  let mode = 'culture';
  if (previousTurns > 0 && (previousMode === 'serious' || previousMode === 'support')) {
    mode = previousMode;
  } else if (seriousScore >= 0.65 || modelMode === 'serious_support' || modelMode === 'explanation') {
    mode = modelMode === 'serious_support' ? 'support' : 'serious';
  } else if (modelMode === 'hybrid' || modelMode === 'judgment') {
    mode = 'hybrid';
  } else if (cultureDefault || cultureScore >= cultureMinScore || modelMode === 'banter') {
    mode = 'culture';
  } else {
    mode = 'hybrid';
  }

  return {
    ...style,
    modelResponseMode: modelMode || 'unknown',
    mode,
    responseMode: mode,
    culturePriority: cultureScore,
    seriousRequest: seriousScore,
    modeConfidence: Math.max(score(style.modeConfidence), Math.abs(cultureScore - seriousScore)),
    modeReason: text(
      mode === 'culture'
        ? '非严肃语境优先文化联想与具体接梗'
        : mode === 'hybrid'
          ? '先接住语境，再补必要结论'
          : mode === 'support'
            ? '现实风险或敏感处境优先稳定回应'
            : '明确追问或连续纠正后进入正经回答',
    ),
  };
}

export class JevResponseModeMemory {
  constructor(options = {}) {
    this.entries = new Map();
    this.maxEntries = Math.max(32, Number(options.maxEntries ?? 512));
    this.ttlMs = Math.max(60_000, Number(options.ttlMs ?? 15 * 60 * 1000));
    this.ttlTurns = Math.max(1, Math.min(4, Number(options.ttlTurns ?? 2)));
    this.now = options.now ?? Date.now;
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.updatedAt + this.ttlMs <= now) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (!oldest) break;
      this.entries.delete(oldest[0]);
    }
  }

  get(key) {
    this.prune();
    const entry = this.entries.get(String(key ?? '').trim());
    return entry ? { ...entry } : null;
  }

  resolve(key, style, options = {}) {
    const normalizedKey = String(key ?? '').trim();
    const previous = this.get(normalizedKey);
    const resolved = resolveJevResponseMode(style, previous, options);
    return { style: resolved, previous };
  }

  commit(key, style) {
    const normalizedKey = String(key ?? '').trim();
    if (!normalizedKey || !style || !RESPONSE_MODES.has(style.mode)) return null;
    const previous = this.get(normalizedKey);
    const remainingTurns = previous?.mode === style.mode
      ? Math.max(0, Number(previous.remainingTurns || 0) - 1)
      : Math.max(0, this.ttlTurns - 1);
    const entry = {
      mode: style.mode,
      remainingTurns,
      reason: text(style.modeReason),
      updatedAt: this.now(),
    };
    this.entries.set(normalizedKey, entry);
    this.prune();
    return { ...entry };
  }
}
