import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { LongtuWebSearch } from '../src/web-search.js';
import { parseExaApiKeys } from '../src/exa-key-pool.js';

const endpoint = 'https://api.exa.ai/search';
const quietLogger = { warn() {} };
const success = () => Response.json({ results: [{
  title: 'Example source', url: 'https://example.com/source', text: 'Verified source text.',
}], costDollars: { total: 0.007 } });
const client = options => new LongtuWebSearch({
  exaApiKeys: ['secret-one', 'secret-two'], fallbackEndpoint: null,
  logger: quietLogger, ...options,
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('key configuration deduplicates ordered lists, supports JSON and keeps legacy fallback', () => {
  assert.deepEqual(parseExaApiKeys(' a, b\na , , c ', 'old'), ['a', 'b', 'c']);
  assert.deepEqual(parseExaApiKeys('["a", "b", "a"]', 'old'), ['a', 'b']);
  assert.deepEqual(parseExaApiKeys([' a ', 'b', 'a']), ['a', 'b']);
  for (const value of ['', '  ', '[]', [], undefined]) {
    assert.deepEqual(parseExaApiKeys(value, ' old '), ['old']);
  }
  for (const value of ['[secret', '[123]', { secret: 'key' }]) {
    assert.throws(() => parseExaApiKeys(value), error => (
      error instanceof TypeError && !error.message.includes('secret')
    ));
  }
  assert.equal(client({}).provider, 'exa');
  assert.equal(new LongtuWebSearch().provider, 'bing');
});

test('402 switches within the same request, preserves options and hooks, sticks to backup and shares cache', async () => {
  const calls = [];
  const hooks = [];
  const warnings = [];
  const search = client({
    maxResults: 5, exaSearchType: 'neural', exaMaxContentCharacters: 1000,
    logger: { warn: message => warnings.push(message) },
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return options.headers['x-api-key'] === 'secret-one'
        ? new Response('secret-one echoed by provider', { status: 402 }) : success();
    },
  });
  const options = {
    mode: 'general', includeDomains: ['example.com'],
    onBeforeUpstreamRequest: info => hooks.push({ phase: 'before', ...info }),
    onUpstreamRequest: info => hooks.push({ phase: 'after', ...info }),
  };
  const first = await search.search('example', options);
  assert.equal(first.resultCount, 1);
  assert.equal((await search.search('example', options)).fromCache, true);
  await search.search('another example', options);
  assert.deepEqual(calls.map(call => call.headers['x-api-key']), ['secret-one', 'secret-two', 'secret-two']);
  assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(JSON.parse(calls[1].body), {
    query: 'example', includeDomains: ['example.com'], numResults: 5,
    type: 'neural', contents: { text: { maxCharacters: 1000 } },
  });
  assert.deepEqual(hooks.map(hook => hook.phase), ['before', 'after', 'before', 'after', 'before', 'after']);
  assert.deepEqual(hooks.filter(hook => hook.phase === 'after').map(hook => hook.succeeded), [false, true, true]);
  assert.equal(hooks[1].costDollars, undefined);
  assert.equal(hooks[3].costDollars.total, 0.007);
  assert.equal(search.exaKeyPool.getStatus().preferredKey, 2);
  assert.doesNotMatch(JSON.stringify({ warnings, hooks, status: search.exaKeyPool.getStatus(), pool: search.exaKeyPool }), /secret-(one|two)/);
});

test('401 disables key until restart, while 402 keys can be retried after thirty minutes', async () => {
  let now = 0;
  let healthy = false;
  const calls = [];
  const search = client({ now: () => now, fetchImpl: async (_url, options) => {
    const key = options.headers['x-api-key'];
    calls.push(key);
    return healthy ? success() : new Response('', { status: key === 'secret-one' ? 401 : 402 });
  } });
  await assert.rejects(search.fetchResults(endpoint, 'example'), /HTTP 402/);
  await assert.rejects(search.fetchResults(endpoint, 'example'), /暂无可用/);
  assert.equal(calls.length, 2);
  now = 30 * 60 * 1000;
  healthy = true;
  await search.fetchResults(endpoint, 'example');
  assert.deepEqual(calls, ['secret-one', 'secret-two', 'secret-two']);
  assert.equal(search.exaKeyPool.getStatus().keys[0].state, 'invalid');
});

for (const [header, waitMs] of [
  ['2', 2000], ['Thu, 01 Jan 1970 00:00:03 GMT', 3000], [null, 60000], ['invalid', 60000],
]) {
  test(`429 respects Retry-After ${header} and recovers without waiting inside the request`, async () => {
    let now = 0;
    let count = 0;
    const search = client({ exaApiKeys: ['only-key'], now: () => now,
      fetchImpl: async () => ++count === 1
        ? new Response('', { status: 429, headers: header ? { 'Retry-After': header } : {} }) : success(),
    });
    await assert.rejects(search.fetchResults(endpoint, 'example'), /HTTP 429/);
    now = waitMs - 1;
    await assert.rejects(search.fetchResults(endpoint, 'example'), /暂无可用/);
    assert.equal(count, 1);
    now += 1;
    await search.fetchResults(endpoint, 'example');
    assert.equal(count, 2);
  });
}

test('429 immediately uses a ready backup and does not recheck cooling primary on the next request', async () => {
  const calls = [];
  const search = client({ fetchImpl: async (_url, options) => {
    const key = options.headers['x-api-key'];
    calls.push(key);
    return key === 'secret-one' ? new Response('', { status: 429 }) : success();
  } });
  await search.fetchResults(endpoint, 'one');
  await search.fetchResults(endpoint, 'two');
  assert.deepEqual(calls, ['secret-one', 'secret-two', 'secret-two']);
});

for (const status of [400, 403, 500, 503]) {
  test(`HTTP ${status} does not rotate or disable credentials`, async () => {
    let calls = 0;
    const search = client({ fetchImpl: async () => {
      calls += 1;
      return new Response('secret-one', { status });
    } });
    await assert.rejects(search.fetchResults(endpoint, 'example'), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
    assert.equal(search.exaKeyPool.getStatus().available, 2);
  });
}

test('network and malformed-body errors are sanitized and do not rotate keys', async () => {
  for (const fetchImpl of [
    () => { throw new Error('network secret-one'); },
    async () => { throw new Error('network secret-one'); },
    async () => new Response('secret-one invalid-json'),
  ]) {
    const search = client({ fetchImpl });
    await assert.rejects(search.fetchResults(endpoint, 'example'), error => !error.message.includes('secret-one'));
    assert.equal(search.exaKeyPool.getStatus().available, 2);
    assert.equal(search.exaKeyPool.getStatus().preferredKey, 1);
  }
});

test('all exhausted keys are attempted at most once and configured web fallback has no Exa header', async () => {
  const calls = [];
  const search = client({ fallbackEndpoint: 'https://www.bing.com/search',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return url.hostname === 'api.exa.ai'
        ? new Response('', { status: 402 })
        : new Response('<rss><channel><item><title>Example</title><link>https://example.com/source</link><description>Example source</description></item></channel></rss>');
    },
  });
  const result = await search.search('example', { mode: 'current' });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.headers['x-api-key'], undefined);
  assert.equal(result.resultCount, 1);
  assert.equal(result.endpoint, 'https://www.bing.com/search');
  assert.equal(search.exaKeyPool.getStatus().available, 0);
});

test('concurrent late success cannot resurrect an exhausted primary or replace the active backup', async () => {
  const pending = deferred();
  let calls = 0;
  const search = client({ fetchImpl: async (_url, options) => {
    calls += 1;
    if (calls === 1) return pending.promise;
    return options.headers['x-api-key'] === 'secret-one' ? new Response('', { status: 402 }) : success();
  } });
  const slow = search.fetchResults(endpoint, 'slow');
  await search.fetchResults(endpoint, 'fast');
  pending.resolve(success());
  await slow;
  assert.equal(search.exaKeyPool.getStatus().preferredKey, 2);
  assert.equal(search.exaKeyPool.getStatus().keys[0].state, 'credits-exhausted');
});

test('stale concurrent failure cannot disable a key that recovered after cooldown', async () => {
  const pending = deferred();
  let now = 0;
  let calls = 0;
  const search = client({ exaApiKeys: ['only-key'], now: () => now, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return pending.promise;
    return calls === 2 ? new Response('', { status: 429 }) : success();
  } });
  const slow = assert.rejects(search.fetchResults(endpoint, 'slow'), /HTTP 429/);
  await assert.rejects(search.fetchResults(endpoint, 'fast'), /HTTP 429/);
  now = 60000;
  await search.fetchResults(endpoint, 'recovered');
  pending.resolve(new Response('', { status: 429 }));
  await slow;
  assert.equal(search.exaKeyPool.getStatus().available, 1);
});

test('failover attempts share one timeout and report aborted upstream without disabling the backup', async () => {
  let calls = 0;
  const events = [];
  const signals = [];
  const search = client({ timeoutMs: 80, fetchImpl: async (_url, options) => {
    calls += 1;
    signals.push(options.signal);
    if (calls === 1) {
      await sleep(10);
      return new Response('', { status: 402 });
    }
    await sleep(300, null, { signal: options.signal });
    return success();
  } });
  await assert.rejects(search.fetchResults(endpoint, 'example', {
    onUpstreamRequest: info => events.push(info),
  }), /80ms/);
  assert.equal(calls, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[1].aborted, true);
  assert.deepEqual(events.map(info => info.succeeded), [false, false]);
  assert.equal(search.exaKeyPool.getStatus().keys[1].state, 'available');
});
