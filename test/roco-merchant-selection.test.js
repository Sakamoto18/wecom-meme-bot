import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMerchantItems } from '../src/roco-merchant-selection.js';

const items = [{ name: '神奇的蛋', description: '不知道可以孵化出哪种精灵' },
  { name: '首领血脉秘药', description: '首领血脉修改道具' }];
test('merchant subscription uses complete evidence and respects none', async () => {
  const client = { isConfigured: true, complete: async (_, input, opts) => {
    assert.equal(opts.usageSource, 'roco-merchant-selection');
    assert.deepEqual(JSON.parse(input).candidates.map(x => x.name), items.map(x => x.name));
    assert.match(opts.systemPrompt, /不是普通的神奇的蛋/);
    assert.match(opts.systemPrompt, /负面影响/);
    return '{"selected":[]}';
  } };
  assert.deepEqual(await selectMerchantItems(client, items), []);
  client.complete = async () => '{"selected":[{"id":"1","category":"leader_potion","confidence":0.98}]}';
  assert.deepEqual(await selectMerchantItems(client, items), [1]);
});
test('malformed, invented and uncertain merchant choices fail closed', async () => {
  for (const value of ['null', '[]', '{}', 'bad',
    '{"selected":[{"id":"9","category":"king_ball","confidence":1}]}',
    '{"selected":[{"id":"0","category":"king_ball","confidence":0.6}]}',
    '{"selected":[{"id":"0","category":"other","confidence":1}]}']) {
    await assert.rejects(selectMerchantItems({ isConfigured: true, complete: async () => value }, items));
  }
});
