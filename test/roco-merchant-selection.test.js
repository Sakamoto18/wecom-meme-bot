import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMerchantItems } from '../src/roco-merchant-selection.js';

const items = [{ name: '神奇的蛋', description: '不知道可以孵化出哪种精灵' },
  { name: '国王球', description: '精灵捕捉道具' }];
test('merchant subscription uses complete evidence and respects none', async () => {
  const client = { isConfigured: true, complete: async (_, input, opts) => {
    assert.equal(opts.usageSource, 'roco-merchant-selection');
    assert.deepEqual(JSON.parse(input).candidates.map(x => x.name), items.map(x => x.name));
    assert.match(opts.systemPrompt, /不是普通的神奇的蛋/);
    assert.match(opts.systemPrompt, /镜面相框、残缺魔镜、适格之钥、能力钥匙/);
    return '{"selected":[]}';
  } };
  assert.deepEqual(await selectMerchantItems(client, items), []);
  client.complete = async () => '{"selected":[{"id":"1","category":"king_ball","confidence":0.98}]}';
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

test('confirmed mirror frame matches its full product name without model interpretation', async () => {
  const stock = [{ name: '魔镜', description: '幽系技能石' },
    { name: ' 镜面相框 ', description: '' },
    { name: '镜面相框碎片', description: '指定性格' },
    { name: '未知金色镜子', description: '可以修改性格正面加成' }];
  const client = { isConfigured: true, complete: async (_, input) => {
    assert.deepEqual(JSON.parse(input).candidates.map(c => c.id), ['0', '2', '3']);
    return '{"selected":[]}';
  } };
  assert.deepEqual(await selectMerchantItems(client, stock), [1]);
  assert.deepEqual(await selectMerchantItems(null, [{ name: '镜面相框' }]), [0]);
  assert.deepEqual(await selectMerchantItems(null, stock), [1]);
});

test('model cannot extend the confirmed mirror subscription to another product', async () => {
  const client = { isConfigured: true, complete: async () =>
    '{"selected":[{"id":"0","category":"nature_mirror","confidence":1}]}' };
  await assert.rejects(selectMerchantItems(client, [{ name: '未知镜子' }]));
  assert.deepEqual(await selectMerchantItems(client, [{ name: '未知镜子' }, { name: '镜面相框' }]), [1]);
});

test('exact mirror binding and other subscribed items are combined', async () => {
  const client = { isConfigured: true, complete: async () =>
    '{"selected":[{"id":"1","category":"king_ball","confidence":1}]}' };
  assert.deepEqual(await selectMerchantItems(client, [{ name: '镜面相框' }, { name: '国王球' }]), [0, 1]);
});

test('all four explicit product subscriptions work without a model and exclude partial names', async () => {
  const stock = ['残缺魔镜', '适格之钥', '能力钥匙', '镜面相框', '能力钥匙碎片', '镜面家具'].map(name => ({ name }));
  assert.deepEqual(await selectMerchantItems(null, stock), [0, 1, 2, 3]);
  const client = { isConfigured: true, complete: async () => '{"selected":[]}' };
  for (const item of stock.slice(0, 4)) {
    assert.deepEqual(await selectMerchantItems(client, [item]), [0]);
  }
  assert.deepEqual(await selectMerchantItems(client, stock.slice(4)), []);
});

test('leader potions are selected for both transports even with an empty or unavailable model', async () => {
  const stock = ['首领秘药', ' 首领血脉秘药 ', '火系血脉秘药', '首领信物', '首领秘药碎片', '奇异血脉秘药'].map(name => ({ name }));
  const client = { isConfigured: true, complete: async (_, input) => {
    assert.deepEqual(JSON.parse(input).candidates.map(c => c.id), ['2', '3', '4', '5']);
    return '{"selected":[]}';
  } };
  assert.deepEqual(await selectMerchantItems(client, stock), [0, 1]);
  assert.deepEqual(await selectMerchantItems(null, stock), [0, 1]);
  assert.deepEqual(await selectMerchantItems(null, stock.slice(0, 2)), [0, 1]);
  client.complete = async () => { throw new Error('model timeout'); };
  assert.deepEqual(await selectMerchantItems(client, stock), [0, 1]);
  client.complete = async () => '{"selected":[{"id":"5","category":"special_potion","confidence":1}]}';
  assert.deepEqual(await selectMerchantItems(client, stock), [0, 1, 5]);
});

test('model cannot broaden the leader potion subscription to a different item', async () => {
  const client = { isConfigured: true, complete: async () =>
    '{"selected":[{"id":"0","category":"leader_potion","confidence":1}]}' };
  await assert.rejects(selectMerchantItems(client, [{ name: '首领信物' }]));
  assert.deepEqual(await selectMerchantItems(client, [{ name: '首领信物' }, { name: '首领秘药' }]), [1]);
});
