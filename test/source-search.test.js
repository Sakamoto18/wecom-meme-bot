import test from 'node:test';
import assert from 'node:assert/strict';
import { LongtuWebSearch } from '../src/web-search.js';
import { buildImageSearchPlan } from '../src/image-reply-context.js';
import { IMAGE_SOURCE_PROMPT, normalizeSourceCandidates, searchWithSourceScope, sourceScopeFromText } from '../src/search-scope.js';

const reddit = normalizeSourceCandidates([{ platform: 'Reddit', confidence: 'medium', evidence: 'u/ 用户名、上下投票箭头与缩进回复' }]);
const hit = (url = 'https://www.reddit.com/r/linux/comments/abc') => ({ title: 'Linux kernel changes', url, text: 'Linux kernel changes discussed here' });

test('裁剪评论按界面特征生成候选，逐图绑定范围，不把私聊或其他图的线索混入', () => {
  assert.match(IMAGE_SOURCE_PROMPT, /没有平台名或 logo/);
  assert.match(IMAGE_SOURCE_PROMPT, /回复缩进与层级/);
  const plan = buildImageSearchPlan({ items: [
    { sourceCandidates: reddit, searchQueries: ['Linux kernel changes'] },
    { sourceCandidates: normalizeSourceCandidates([{ platform: 'github', confidence: 'high', evidence: 'issue 标签与编号布局' }]), searchQueries: ['Linux kernel changes'] },
    { sourceCandidates: reddit, keywords: ['secret'], searchQueries: [] },
  ] });
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0].includeDomains, ['reddit.com']);
  assert.deepEqual(plan[1].includeDomains, ['github.com']);
  assert.equal(plan[0].crossCheck, true);
  assert.equal(plan[1].crossCheck, false);
  assert.deepEqual(normalizeSourceCandidates([{ platform: 'reddit', confidence: 'high' }]), []);
  assert.deepEqual(sourceScopeFromText('Twitter 和 Reddit 有什么区别').includeDomains, []);
  assert.deepEqual(sourceScopeFromText('https://x.com/example/status/123').includeDomains, ['twitter.com', 'x.com']);
});

test('Exa 平台域名约束写进请求并隔离缓存，过滤范围外和伪域名结果', async () => {
  const calls = [];
  const search = new LongtuWebSearch({ provider: 'exa', exaApiKey: 'test', fallbackEndpoint: null,
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ results: [hit(), hit('https://reddit.com.evil.test/post'), hit('https://github.com/linux')] }));
    } });
  const scoped = await search.search('Linux', { mode: 'general', includeDomains: ['reddit.com'] });
  assert.deepEqual(calls[0].includeDomains, ['reddit.com']);
  assert.equal(scoped.resultCount, 1);
  assert.equal((await search.search('Linux', { mode: 'general', includeDomains: ['reddit.com', 'reddit.com'] })).fromCache, true);
  assert.equal((await search.search('Linux', { mode: 'general' })).resultCount, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].includeDomains, undefined);
});

test('Bing 降级也保留 site 范围和域名校验，不用外站结果冒充原平台', async () => {
  let query;
  const search = new LongtuWebSearch({ provider: 'exa', exaApiKey: 'test', fallbackEndpoint: 'https://www.bing.com/search',
    fetchImpl: async (url) => {
      if (url.hostname === 'api.exa.ai') throw new Error('Exa unavailable');
      query = url.searchParams.get('q');
      return new Response('<rss><channel><item><title>Linux discussion</title><link>https://reddit.com/r/linux</link></item><item><title>Linux repost</title><link>https://example.com/repost</link></item></channel></rss>');
    } });
  const result = await search.search('Linux', { mode: 'general', includeDomains: ['reddit.com'] });
  assert.match(query, /site:reddit.com/);
  assert.equal(result.resultCount, 1);
});

test('中等置信度有命中仍全网交叉确认，高置信无结果或错误才放宽，保留失败提示', async () => {
  for (const state of ['ambiguous', 'empty', 'failed', 'confident']) {
    const calls = [];
    const result = await searchWithSourceScope({ async search(query, options) {
      calls.push(options.includeDomains);
      if (options.includeDomains.length && state === 'failed') throw new Error('timeout');
      return { resultCount: options.includeDomains.length && state === 'empty' ? 0 : 1,
        context: options.includeDomains.length && state === 'empty' ? '' : 'public evidence', results: [] };
    } }, 'Linux', { mode: 'general' }, { candidates: reddit, includeDomains: ['reddit.com'], crossCheck: state === 'ambiguous' });
    assert.equal(calls.length, state === 'confident' ? 1 : 2);
    assert.match(result.context, /尚未核实/);
    if (state !== 'confident') assert.match(result.context, /转载和相似内容不能证明截图出处/);
  }
});
