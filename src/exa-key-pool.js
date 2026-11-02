const CREDIT_RECHECK_MS = 30 * 60 * 1000;
const RATE_COOLDOWN_MS = 60 * 1000;

export function parseExaApiKeys(value, legacyKey = '') {
  let entries = value;
  if (typeof entries === 'string') {
    const text = entries.trim();
    if (text.startsWith('[')) {
      try { entries = JSON.parse(text); } catch {
        throw new TypeError('Exa 多 key 配置必须是 JSON 字符串数组或逗号分隔列表');
      }
    } else {
      entries = text.split(/[,\s]+/);
    }
  }
  if (entries != null && (!Array.isArray(entries)
    || entries.some(key => typeof key !== 'string'))) {
    throw new TypeError('Exa 多 key 配置必须是字符串数组或逗号分隔列表');
  }
  const keys = [...new Set((entries ?? []).map(key => key.trim()).filter(Boolean))];
  return keys.length ? keys : [String(legacyKey).trim()].filter(Boolean);
}

export class ExaHttpError extends Error {
  constructor(response) {
    super(`联网检索失败（HTTP ${response.status}）`);
    this.name = 'ExaHttpError';
    this.status = response.status;
    this.retryAfter = response.headers?.get?.('retry-after');
  }
}

// Secret values stay private; diagnostics expose only ordinal numbers and state.
export class ExaKeyPool {
  #entries;
  #current = 0;
  #now;
  #logger;

  constructor(keys, { now = Date.now, logger = console } = {}) {
    this.#entries = keys.map(key => ({ key, reason: '', retryAt: 0, generation: 0 }));
    this.#now = now;
    this.#logger = logger;
  }

  get size() { return this.#entries.length; }

  acquire(attempted) {
    const now = this.#now();
    for (let offset = 0; offset < this.size; offset += 1) {
      const index = (this.#current + offset) % this.size;
      const entry = this.#entries[index];
      if (attempted.has(index) || entry.retryAt > now) continue;
      if (entry.reason) {
        entry.reason = '';
        entry.retryAt = 0;
        entry.generation += 1;
      }
      this.#current = index;
      return { index, key: entry.key, generation: entry.generation };
    }
    return null;
  }

  reject(lease, error) {
    // 403 may be a content-policy rejection; changing credentials must not retry it.
    if (!(error instanceof ExaHttpError) || ![401, 402, 429].includes(error.status)) {
      return false;
    }
    const entry = this.#entries[lease.index];
    if (entry.generation !== lease.generation) return true;
    const now = this.#now();
    let delay = CREDIT_RECHECK_MS;
    let reason = 'credits-exhausted';
    if (error.status === 401) {
      reason = 'invalid';
      delay = Infinity;
    } else if (error.status === 429) {
      reason = 'rate-limited';
      const value = String(error.retryAfter ?? '').trim();
      const seconds = value ? Number(value) : NaN;
      const date = Date.parse(value);
      delay = Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1000
        : (Number.isFinite(date) ? date - now : RATE_COOLDOWN_MS);
      delay = Math.max(1000, delay);
    }
    entry.reason = reason;
    entry.retryAt = now + delay;
    entry.generation += 1;
    this.#logger.warn?.(`Exa key #${lease.index + 1}: ${reason} (HTTP ${error.status})`);
    return true;
  }

  getStatus() {
    const now = this.#now();
    const keys = this.#entries.map((entry, index) => ({
      number: index + 1,
      state: entry.retryAt > now ? entry.reason : 'available',
      retryAt: entry.retryAt > now && Number.isFinite(entry.retryAt) ? entry.retryAt : null,
    }));
    return {
      configured: this.size,
      available: keys.filter(key => key.state === 'available').length,
      preferredKey: this.size ? this.#current + 1 : null,
      keys,
    };
  }
}
