import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createQqApiServer } from '../src/qq-api.js';

test('merchant evidence endpoint requires authentication and does not enter conversation handling', async t => {
  let calls = 0;
  const server = createQqApiServer({ apiToken: 'merchant-test-token', service: {
    handleMessage: () => { throw new Error('must not create a conversation'); },
    chatClient: { isConfigured: true, complete: async () => { calls++; return '{"selected":[]}'; } },
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/v1/qq/merchant/select`;
  const body = JSON.stringify({ items: [{ name: '神奇的蛋', description: '普通精灵蛋' }] });
  assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
  assert.equal(calls, 0);
  const response = await fetch(url, { method: 'POST', body, headers: { Authorization: 'Bearer merchant-test-token' } });
  assert.deepEqual(await response.json(), { ok: true, selected: [] });
  assert.equal(calls, 1);
  const subscribed = await fetch(url, { method: 'POST',
    body: JSON.stringify({ items: [{ name: '首领秘药' }, { name: '首领血脉秘药' }] }),
    headers: { Authorization: 'Bearer merchant-test-token' },
  });
  assert.deepEqual(await subscribed.json(), { ok: true, selected: [0, 1] });
  assert.equal(calls, 1, 'confirmed potions do not need a model call');
});
