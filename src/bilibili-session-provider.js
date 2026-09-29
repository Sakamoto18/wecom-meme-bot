function normalizeEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.pathname.endsWith('/resolve')) {
      url.pathname = url.pathname.slice(0, -'/resolve'.length);
    }
    url.search = '';
    url.hash = '';
    return url.href.replace(/\/+$/u, '');
  } catch {
    return raw.replace(/\/+$/u, '').replace(/\/resolve$/u, '');
  }
}

/**
 * Read the Bilibili session from the browser provider without persisting a
 * cookie in qq-bot's environment. The endpoint is only reachable on the
 * private Docker network and returns no cookie when the account is logged out.
 */
export function createBilibiliSessionProvider({ providerUrl, timeoutMs = 800 } = {}) {
  const endpoint = normalizeEndpoint(providerUrl);
  if (!endpoint) return null;
  return async () => {
    try {
      const response = await fetch(`${endpoint}/bilibili-cookie`, {
        signal: AbortSignal.timeout(Math.max(200, Number(timeoutMs) || 800)),
      });
      if (!response.ok) return '';
      const payload = await response.json();
      return payload?.logged_in && typeof payload.cookie === 'string'
        ? payload.cookie.trim()
        : '';
    } catch {
      return '';
    }
  };
}

export { normalizeEndpoint as normalizeBilibiliProviderEndpoint };
