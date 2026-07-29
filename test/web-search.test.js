import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LongtuWebSearch,
  parseBaiduSearchHtml,
  parseSearchRss,
  selectLongtuSearchQuery,
} from '../src/web-search.js';

const SAMPLE_BAIDU = `
<html><body>
  <span class="summary-text_15QGa click-area">普通新闻摘要</span>
  <span class="summary-text_15QGa click-area"><em>难说</em>,毕竟你不配#<em>龙图表情包</em> #龙玉涛</span>
  <span class="other">杀妈不在摘要节点中</span>
  <span class="summary-text_15QGa">龙玉涛的梗：“你舍得打破这份宁静吗”、“杀妈”、“让我龙一下”等。</span>
</body></html>`;

const SAMPLE_RSS = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title>普通的龙百科</title>
    <link>https://example.com/dragon</link>
    <description>古代神话动物</description>
  </item>
  <item>
    <title><![CDATA[贴吧里的龙玉涛表情包讨论]]></title>
    <link>https://tieba.baidu.com/p/123</link>
    <description>网友讨论龙图、老冯与群聊斗图语境 &amp; 用法</description>
  </item>
  <item>
    <title>龙图梗整理</title>
    <link>https://example.com/longtu</link>
    <description>龙图表情包的公开摘要</description>
  </item>
</channel></rss>`;

test('解析搜索 RSS 时只保留龙图相关摘要', () => {
  const results = parseSearchRss(SAMPLE_RSS, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, '贴吧里的龙玉涛表情包讨论');
  assert.match(results[0].description, /斗图语境 & 用法/);
});

test('解析百度公开搜索摘要并保留可核验原句', () => {
  const results = parseBaiduSearchHtml(SAMPLE_BAIDU, 5);
  assert.equal(results.length, 2);
  assert.match(results[0].description, /难说\s*,毕竟你不配/);
  assert.match(results[1].description, /杀妈/);
});

test('搜索只发送固定白名单查询，不泄露群聊原文，并缓存结果', async () => {
  let calls = 0;
  let capturedUrl;
  const search = new LongtuWebSearch({
    endpoint: 'https://www.bing.com/search',
    fallbackEndpoint: null,
    fetchImpl: async (url) => {
      calls += 1;
      capturedUrl = String(url);
      return new Response(SAMPLE_RSS, { status: 200 });
    },
  });

  const first = await search.search('你老冯没了 private-group-text-123');
  const second = await search.search('另一个人提到你妈');

  assert.equal(calls, 1);
  assert.equal(first.resultCount, 2);
  assert.equal(second.fromCache, true);
  assert.doesNotMatch(capturedUrl, /private-group-text-123/);
  assert.match(decodeURIComponent(capturedUrl), /龙玉涛/);
  assert.match(first.context, /不可信外部资料/);
});

test('百度没有结果时自动降级到 Bing RSS', async () => {
  const requestedHosts = [];
  const search = new LongtuWebSearch({
    fetchImpl: async (url) => {
      requestedHosts.push(new URL(url).hostname);
      if (requestedHosts.length === 1) {
        return new Response('<title>百度安全验证</title>', { status: 200 });
      }
      return new Response(SAMPLE_RSS, { status: 200 });
    },
  });

  const result = await search.search('你真是司马了');
  assert.deepEqual(requestedHosts, ['www.baidu.com', 'www.bing.com']);
  assert.equal(result.resultCount, 2);
  assert.match(result.endpoint, /bing\.com/);
});

test('按龙图话题选择有限的固定查询', () => {
  assert.match(selectLongtuSearchQuery('你老冯没了'), /你妈/);
  assert.match(selectLongtuSearchQuery('你可真司马'), /你妈/);
  assert.match(selectLongtuSearchQuery('妈死了'), /你妈/);
  assert.match(selectLongtuSearchQuery('你码'), /你妈/);
  assert.match(selectLongtuSearchQuery('尼玛'), /你妈/);
  assert.match(selectLongtuSearchQuery('你玩原神吗'), /原神/);
  assert.match(selectLongtuSearchQuery('你好'), /经典文案/);
});
