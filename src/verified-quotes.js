function normalizeForMatch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[\s#，,。！？!?：“”"'、·…—_-]+/g, '');
}

function validateEntry(entry, index) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`网络语料第 ${index + 1} 项格式无效`);
  }
  if (!entry.id || !entry.text || !Array.isArray(entry.categories) || entry.categories.length === 0) {
    throw new Error(`网络语料第 ${index + 1} 项缺少 id、text 或 categories`);
  }
  if (!entry.source?.provider || !entry.source?.query || !entry.source?.verifiedAt) {
    throw new Error(`网络语料 ${entry.id} 缺少来源记录`);
  }
}

function entryAppearsInResults(entry, results) {
  const needles = [entry.text, ...(entry.matchTexts ?? [])]
    .map(normalizeForMatch)
    .filter(Boolean);

  return results.some((result) => {
    const haystack = normalizeForMatch(`${result.title ?? ''} ${result.description ?? ''}`);
    return needles.some((needle) => haystack.includes(needle));
  });
}

export class VerifiedQuoteStore {
  constructor(entries = [], options = {}) {
    entries.forEach(validateEntry);
    this.entries = entries.map((entry) => ({ ...entry }));
    this.random = options.random ?? Math.random;
    this.recentIds = [];
    this.recentLimit = options.recentLimit ?? 2;
  }

  pick(category, searchResults = []) {
    const eligible = this.entries.filter((entry) => entry.categories.includes(category));
    if (eligible.length === 0) {
      return null;
    }

    const liveMatches = eligible.filter((entry) => entryAppearsInResults(entry, searchResults));
    const sourcePool = liveMatches.length > 0 ? liveMatches : eligible;
    const freshPool = sourcePool.filter((entry) => !this.recentIds.includes(entry.id));
    const pool = freshPool.length > 0 ? freshPool : sourcePool;
    const rawIndex = Math.floor(this.random() * pool.length);
    const selected = pool[Math.max(0, Math.min(pool.length - 1, rawIndex))];

    this.recentIds.push(selected.id);
    if (this.recentIds.length > this.recentLimit) {
      this.recentIds.shift();
    }

    return {
      ...selected,
      retrieval: liveMatches.includes(selected) ? 'live-search' : 'verified-cache',
    };
  }

  getReferences(category, searchResults = [], limit = 3) {
    const eligible = this.entries.filter((entry) => entry.categories.includes(category));
    const liveMatches = eligible.filter((entry) => entryAppearsInResults(entry, searchResults));
    const remaining = eligible.filter((entry) => !liveMatches.includes(entry));
    const offset = remaining.length > 0
      ? Math.floor(this.random() * remaining.length) % remaining.length
      : 0;
    const rotated = [...remaining.slice(offset), ...remaining.slice(0, offset)];

    return [...liveMatches, ...rotated]
      .slice(0, Math.max(0, limit))
      .map((entry) => ({
        ...entry,
        retrieval: liveMatches.includes(entry) ? 'live-search' : 'verified-cache',
      }));
  }

  isExactQuote(category, content) {
    const normalized = normalizeForMatch(content);
    return this.entries.some((entry) => (
      entry.categories.includes(category)
      && normalizeForMatch(entry.text) === normalized
    ));
  }
}

export { normalizeForMatch };
