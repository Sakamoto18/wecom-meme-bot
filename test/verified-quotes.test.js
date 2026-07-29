import test from 'node:test';
import assert from 'node:assert/strict';
import { VerifiedQuoteStore } from '../src/verified-quotes.js';

const ENTRIES = [
  {
    id: 'online-a',
    text: '难说，毕竟你不配',
    matchTexts: ['难说,毕竟你不配'],
    categories: ['attack'],
    source: { provider: '测试搜索', query: '固定查询', verifiedAt: '2026-07-29' },
  },
  {
    id: 'online-b',
    text: '让我龙一下',
    categories: ['attack'],
    source: { provider: '测试搜索', query: '固定查询', verifiedAt: '2026-07-29' },
  },
];

test('优先选择本轮搜索摘要中实际出现的已核验原句', () => {
  const store = new VerifiedQuoteStore(ENTRIES, { random: () => 0.9 });
  const picked = store.pick('attack', [{
    title: '龙图表情包',
    description: '公开页面写着：难说, 毕竟你不配。',
  }]);

  assert.equal(picked.id, 'online-a');
  assert.equal(picked.text, '难说，毕竟你不配');
  assert.equal(picked.retrieval, 'live-search');
});

test('联网没有命中时只回退到带来源的已核验语料', () => {
  const store = new VerifiedQuoteStore(ENTRIES, { random: () => 0 });
  const picked = store.pick('attack', []);
  assert.equal(picked.id, 'online-a');
  assert.equal(picked.retrieval, 'verified-cache');
  assert.equal(picked.source.provider, '测试搜索');
});

test('可返回多条轮换参考，并识别整句复刻', () => {
  const store = new VerifiedQuoteStore(ENTRIES, { random: () => 0 });
  const references = store.getReferences('attack', [], 2);
  assert.equal(references.length, 2);
  assert.ok(references.every((entry) => entry.retrieval === 'verified-cache'));
  assert.equal(store.isExactQuote('attack', '难说，毕竟你不配！'), true);
  assert.equal(store.isExactQuote('attack', '难说，但我觉得你配'), false);
});
