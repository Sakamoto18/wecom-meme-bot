import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaResolver } from '../src/media-resolver.js';

function controlledSleeps() {
  const calls = [];
  const waiters = [];
  return {
    calls,
    sleep(ms) {
      const gate = Promise.withResolvers();
      calls.push({ ms, ...gate });
      for (const waiter of waiters) if (calls.length >= waiter.count) waiter.resolve();
      return gate.promise;
    },
    reached(count) {
      if (calls.length >= count) return Promise.resolve();
      return new Promise(resolve => waiters.push({ count, resolve }));
    },
  };
}

const candidate = key => ({ provider: 'douyin', url: `https://www.douyin.com/note/${key}` });
const gallery = id => ({ sourceId: id, contentKind: 'gallery', images: [`https://cdn.example/${id}.jpg`] });

async function setup(t, options = {}) {
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'media-jitter-'));
  const sleeps = controlledSleeps();
  const resolver = new MediaResolver({ enabled: true, cacheDirectory,
    startDelayMinMs: 1000, startDelayMaxMs: 10_000, sleep: sleeps.sleep,
    logger: { info() {}, warn() {} }, ...options,
  });
  t.after(async () => {
    for (const gate of sleeps.calls) gate.resolve();
    resolver.close();
    await rm(cacheDirectory, { recursive: true, force: true });
  });
  return { resolver, sleeps };
}

test('三群冷缓存独立打散，最短延迟先抓，另外两群分别共用任务和命中缓存', { timeout: 2000 }, async t => {
  const samples = [0.9, 0, 0.4];
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const joined = Promise.withResolvers();
  let providerCalls = 0;
  const { resolver, sleeps } = await setup(t, {
    random: () => samples.shift(),
    logger: { info(message) { if (message.includes('共用任务')) joined.resolve(); }, warn() {} },
    providerResolver: async () => { providerCalls++; started.resolve(); await finish.promise; return gallery('123'); },
  });
  const first = resolver.resolve(candidate('123'));
  await sleeps.reached(1);
  const second = resolver.resolve(candidate('123'));
  await sleeps.reached(2);
  const third = resolver.resolve(candidate('123'));
  await sleeps.reached(3);
  assert.deepEqual(sleeps.calls.map(c => c.ms), [9100, 1000, 4600]);
  assert.equal(resolver.active, 0);
  assert.equal(resolver.inflight.size, 0);
  assert.equal(providerCalls, 0);

  // The second arrival wins the delay race; the third joins its unfinished job.
  sleeps.calls[1].resolve();
  await started.promise;
  sleeps.calls[2].resolve();
  await joined.promise;
  assert.equal(providerCalls, 1);
  finish.resolve();
  const winner = await second;
  assert.strictEqual(await third, winner);
  sleeps.calls[0].resolve();
  assert.strictEqual(await first, winner);

  // A later warm-cache request never draws another delay or calls the provider.
  assert.strictEqual(await resolver.resolve(candidate('123')), winner);
  assert.equal(sleeps.calls.length, 3);
  assert.equal(providerCalls, 1);
  assert.equal(resolver.active, 0);
});

test('不同链接按延迟竞速启动，并发抓取谁先完成谁先返回', { timeout: 2000 }, async t => {
  const samples = [0.9, 0, 0.1];
  const started = new Map(['1', '2', '3'].map(id => [id, Promise.withResolvers()]));
  const finishes = new Map(['1', '2', '3'].map(id => [id, Promise.withResolvers()]));
  const completed = [];
  const { resolver, sleeps } = await setup(t, { random: () => samples.shift(), maxConcurrent: 2,
    providerResolver: async ({ url }) => {
      const id = new URL(url).pathname.split('/').at(-1);
      started.get(id).resolve();
      await finishes.get(id).promise;
      return gallery(id);
    },
  });
  const pending = [];
  for (const id of ['1', '2', '3']) {
    pending.push(resolver.resolve(candidate(id)).then(value => { completed.push(id); return value; }));
    await sleeps.reached(pending.length);
  }
  sleeps.calls[1].resolve();
  sleeps.calls[2].resolve();
  await Promise.all([started.get('2').promise, started.get('3').promise]);
  assert.equal(resolver.active, 2);
  assert.equal(resolver.waiters.length, 0); // The long jitter consumes no slot.
  finishes.get('3').resolve();
  await pending[2];
  assert.deepEqual(completed, ['3']);
  finishes.get('2').resolve();
  await pending[1];
  sleeps.calls[0].resolve();
  await started.get('1').promise;
  finishes.get('1').resolve();
  const results = await Promise.all(pending);
  assert.deepEqual(completed, ['3', '2', '1']);
  assert.deepEqual(results.map(r => r.sourceId), ['1', '2', '3']);
});

test('过期缓存重新打散抓取，失败不缓存且下次仍可重试', { timeout: 2000 }, async t => {
  let calls = 0;
  const { resolver, sleeps } = await setup(t, { random: () => 0,
    providerResolver: async () => { if (++calls === 2) throw new Error('temporary failure'); return gallery('123'); },
  });
  const first = resolver.resolve(candidate('123'));
  await sleeps.reached(1);
  sleeps.calls[0].resolve();
  await first;
  for (const entry of resolver.cache.values()) entry.expiresAt = Date.now() - 1;
  const failure = assert.rejects(resolver.resolve(candidate('123')), /temporary failure/);
  await sleeps.reached(2);
  sleeps.calls[1].resolve();
  await failure;
  assert.equal(resolver.cache.size, 0);
  assert.equal(resolver.inflight.size, 0);
  assert.equal(resolver.active, 0);
  const retry = resolver.resolve(candidate('123'));
  await sleeps.reached(3);
  sleeps.calls[2].resolve();
  assert.equal((await retry).sourceId, '123');
  assert.equal(calls, 3);
});

test('媒体打散不超过十秒，关闭时缓存未命中也不等待', async t => {
  const seen = [];
  const { resolver } = await setup(t, { startDelayMinMs: 20_000, startDelayMaxMs: 60_000,
    random: () => 1, sleep: async ms => { seen.push(ms); }, providerResolver: async () => gallery('123'),
  });
  await resolver.resolve(candidate('123'));
  assert.deepEqual(seen, [10_000]);
  resolver.cache.clear();
  resolver.startDelayMaxMs = 0;
  await resolver.resolve(candidate('123'));
  assert.deepEqual(seen, [10_000]);
});

test('官方请求跳过随机等待但不修改 NapCat 延迟或并发限制', { timeout: 2000 }, async t => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const { resolver, sleeps } = await setup(t, { maxConcurrent: 1,
    providerResolver: async ({ url }) => {
      const id = new URL(url).pathname.split('/').at(-1);
      if (id === '1') { started.resolve(); await finish.promise; }
      return gallery(id);
    },
  });
  const official = resolver.resolve(candidate('1'), { skipStartDelay: true });
  await started.promise;
  assert.equal(sleeps.calls.length, 0);
  const legacy = resolver.resolve(candidate('2'));
  await sleeps.reached(1);
  assert.equal(resolver.active, 1);
  sleeps.calls[0].resolve();
  finish.resolve();
  assert.deepEqual((await Promise.all([official, legacy])).map(x => x.sourceId), ['1', '2']);
  assert.equal(sleeps.calls.length, 1);
  assert.equal(resolver.startDelayMaxMs, 10_000);
});
