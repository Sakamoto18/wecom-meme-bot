import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LongtuWebSearch,
  parseBaiduSearchHtml,
  parseExaSearchJson,
  parseSoSearchHtml,
  parseSearchRss,
  selectCurrentSearchQuery,
  selectGeneralSearchQuery,
  selectLongtuSearchQuery,
  selectMemeSearchQuery,
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

const SAMPLE_SO = `
<html><body><ul class="result">
  <li class="res-list"><h3 class="res-title">
    <a href="https://www.so.com/link?m=redirect" data-mdurl="https://www.bilibili.com/video/BV1meme">
      <em>曼波曼波</em>是什么梗？【网络梗知识】
    </a></h3>
    <p class="res-desc"><span class="gray">2024年4月7日&nbsp;-&nbsp;</span>
      <em>曼波</em>梗来自赛马娘二创，随后因魔性配音传播。</p>
  </li>
  <li class="res-list"><h3 class="res-title"><a data-mdurl="https://example.com/other">普通电影新闻</a></h3>
    <p class="res-desc">与查询词完全无关的摘要</p>
  </li>
</ul></body></html>`;

const SAMPLE_EXA = {
  results: [
    {
      title: '玄武之声近期话题整理',
      url: 'https://news.example.com/xuanwu',
      publishedDate: '2026-08-06T08:00:00.000Z',
      author: '测试编辑',
      text: '原文直接说明了该话题的起因与传播过程，这是从网页正文中提取的内容。',
    },
    {
      title: '无关结果',
      url: 'https://example.com/other',
      text: '与当前查询完全无关。',
    },
  ],
};

test('解析搜索 RSS 时只保留龙图相关摘要', () => {
  const results = parseSearchRss(SAMPLE_RSS, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, '贴吧里的龙玉涛表情包讨论');
  assert.match(results[0].description, /斗图语境 & 用法/);
});

test('普通时效检索会保留非龙图搜索结果', () => {
  const results = parseSearchRss(SAMPLE_RSS, 5, { mode: 'current' });
  assert.equal(results.length, 3);
  assert.equal(results[0].title, '普通的龙百科');
});

test('解析百度公开搜索摘要并保留可核验原句', () => {
  const results = parseBaiduSearchHtml(SAMPLE_BAIDU, 5);
  assert.equal(results.length, 2);
  assert.match(results[0].description, /难说\s*,毕竟你不配/);
  assert.match(results[1].description, /杀妈/);
});

test('解析 Exa 搜索结果时保留网页正文、作者和发布时间', () => {
  const results = parseExaSearchJson(SAMPLE_EXA, 6, {
    mode: 'general',
    relevanceTerms: ['玄武之声'],
    maxContentCharacters: 1_200,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].contentSource, 'exa-extracted-text');
  assert.equal(results[0].author, '测试编辑');
  assert.match(results[0].publishedDate, /2026-08-06/);
  assert.match(results[0].description, /网页正文/);
});

test('Exa 使用官方 Search API 的语义检索和限长正文', async () => {
  const calls = [];
  const search = new LongtuWebSearch({
    provider: 'exa',
    exaApiKey: 'exa-test-key',
    maxResults: 6,
    exaMaxContentCharacters: 1_200,
    fallbackEndpoint: null,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ results: [SAMPLE_EXA.results[0]] }), { status: 200 });
    },
  });

  const result = await search.search('玄武之声是什么', { mode: 'general' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.exa.ai/search');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['x-api-key'], 'exa-test-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    query: '玄武之声是什么',
    numResults: 6,
    type: 'auto',
    contents: { text: { maxCharacters: 1_200 } },
  });
  assert.equal(result.endpoint, 'https://api.exa.ai/search');
  assert.equal(result.resultCount, 1);
  assert.match(result.context, /Exa 搜索并提取公开网页正文/);
  assert.match(result.context, /只有单一来源时必须明说/);
  assert.match(result.context, /news\.example\.com/);
});

test('Exa 首轮没有有效结果时才按复合主题回退检索', async () => {
  const queries = [];
  const search = new LongtuWebSearch({
    provider: 'exa',
    exaApiKey: 'exa-test-key',
    fallbackEndpoint: null,
    fetchImpl: async (_url, options) => {
      const query = JSON.parse(options.body).query;
      queries.push(query);
      const results = query === '竹知了和玄武之声到底是什么梗'
        ? []
        : [{
          title: `${query}相关资料`,
          url: `https://example.com/${queries.length}`,
          text: `${query}的网页正文。`,
        }];
      return new Response(JSON.stringify({ results }), { status: 200 });
    },
  });

  const result = await search.search('竹知了和玄武之声到底是什么梗', { mode: 'general' });

  assert.deepEqual(queries, [
    '竹知了和玄武之声到底是什么梗',
    '竹知了',
    '玄武之声',
  ]);
  assert.equal(result.resultCount, 2);
});

test('解析 360 搜索结果时使用原始目标链接并过滤无关梗结果', () => {
  const results = parseSoSearchHtml(SAMPLE_SO, 5, {
    mode: 'meme',
    relevanceTerms: ['曼波'],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, '曼波曼波 是什么梗？【网络梗知识】');
  assert.equal(results[0].url, 'https://www.bilibili.com/video/BV1meme');
  assert.match(results[0].description, /赛马娘二创/);
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

test('Bing RSS 没有结果时直接返回空结果且不请求 360', async () => {
  const requestedHosts = [];
  const search = new LongtuWebSearch({
    fetchImpl: async (url) => {
      requestedHosts.push(new URL(url).hostname);
      return new Response('<rss><channel></channel></rss>', { status: 200 });
    },
  });

  const result = await search.search('曼波是什么意思', { mode: 'meme' });
  assert.deepEqual(requestedHosts, ['www.bing.com']);
  assert.equal(result.resultCount, 0);
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

test('时效搜索查询会清理内部成员编号并补充当前年份', () => {
  const query = selectCurrentSearchQuery(
    '帮我联网查询一下 OpenAI 最新模型 成员-acde12',
    { currentYear: 2026 },
  );
  assert.match(query, /OpenAI 最新模型/);
  assert.match(query, /2026/);
  assert.doesNotMatch(query, /成员-acde12|联网查询/);
});

test('通用搜索保留当前问题但不泄露内部成员编号', () => {
  assert.equal(
    selectGeneralSearchQuery('帮我联网查一下 如何评价时代少年团粉丝 成员-acde12'),
    '如何评价时代少年团粉丝',
  );
});

test('网络梗搜索会提取梗词并追加来源与含义查询词', () => {
  assert.equal(selectMemeSearchQuery('牢大是什么梗'), '牢大 网络梗 来源 含义');
  assert.equal(selectMemeSearchQuery('查一下牢大这个梗'), '牢大 网络梗 来源 含义');
  assert.equal(selectMemeSearchQuery('帮我联网查一下曼波是什么意思'), '曼波 网络梗 来源 含义');
  assert.equal(
    selectMemeSearchQuery('最近的新梗是什么梗', { currentYear: 2026 }),
    '最近的新梗 网络梗 来源 含义 2026',
  );
});

test('meme 模式通过 360 搜索相关梗并注入来源约束', async () => {
  let capturedUrl;
  const search = new LongtuWebSearch({
    endpoint: 'https://www.so.com/s',
    fallbackEndpoint: null,
    fetchImpl: async (url) => {
      capturedUrl = String(url);
      return new Response(SAMPLE_SO, { status: 200 });
    },
  });

  const result = await search.search('曼波是什么意思', { mode: 'meme' });
  assert.equal(result.resultCount, 1);
  assert.equal(new URL(capturedUrl).searchParams.get('q'), '曼波 网络梗 来源 含义');
  assert.match(result.context, /网络梗联网检索摘要/);
  assert.match(result.context, /来源域名：www\.bilibili\.com/);
  assert.match(result.context, /不得编造/);
});

test('复合梗词会拆成多个相关性词，不再被整串过滤', async () => {
  const search = new LongtuWebSearch({
    endpoint: 'https://www.so.com/s',
    fallbackEndpoint: null,
    fetchImpl: async () => new Response(SAMPLE_SO, { status: 200 }),
  });

  const result = await search.search('曼波和赛马娘是什么梗', { mode: 'meme' });
  assert.equal(result.resultCount, 1);
  assert.match(result.results[0].description, /赛马娘/);
});

test('general 模式搜索原问题并保留普通结果', async () => {
  let capturedUrl;
  const search = new LongtuWebSearch({
    endpoint: 'https://www.bing.com/search',
    fallbackEndpoint: null,
    fetchImpl: async (url) => {
      capturedUrl = String(url);
      return new Response(SAMPLE_RSS, { status: 200 });
    },
  });

  const result = await search.search('如何评价时代少年团粉丝', { mode: 'general' });
  assert.equal(new URL(capturedUrl).searchParams.get('q'), '如何评价时代少年团粉丝');
  assert.equal(result.resultCount, 3);
  assert.match(result.context, /通用联网检索摘要/);
  assert.match(result.context, /只采用与用户当前问题直接相关的信息/);
});

test('通用复合查询在 Bing 退化时按核心词回退并过滤无关结果', async () => {
  const queries = [];
  const rss = (title, url) => `<rss><channel><item><title>${title}</title><link>https://example.com/${url}</link><description>摘要</description></item></channel></rss>`;
  const search = new LongtuWebSearch({
    endpoint: 'https://www.bing.com/search',
    fallbackEndpoint: null,
    fetchImpl: async (url) => {
      const query = new URL(url).searchParams.get('q');
      queries.push(query);
      if (query === '竹知了和玄武之声到底是什么梗') {
        return new Response(rss('竹（植物）百科', 'irrelevant'), { status: 200 });
      }
      if (query === '竹知了') {
        return new Response(rss('竹知了近期话题', 'zhu'), { status: 200 });
      }
      return new Response(rss('玄武之声相关报道', 'xuanwu'), { status: 200 });
    },
  });

  const result = await search.search('竹知了和玄武之声到底是什么梗', { mode: 'general' });
  assert.deepEqual(queries, [
    '竹知了和玄武之声到底是什么梗',
    '竹知了',
    '玄武之声',
  ]);
  assert.equal(result.resultCount, 2);
  assert.match(result.context, /竹知了近期话题/);
  assert.match(result.context, /玄武之声相关报道/);
  assert.doesNotMatch(result.context, /竹（植物）百科/);
});

test('current 模式发送普通查询并注入带来源的时效摘要', async () => {
  let capturedUrl;
  const search = new LongtuWebSearch({
    endpoint: 'https://www.bing.com/search',
    fallbackEndpoint: null,
    fetchImpl: async (url) => {
      capturedUrl = String(url);
      return new Response(SAMPLE_RSS, { status: 200 });
    },
  });

  const result = await search.search('今天有什么新消息', {
    mode: 'current',
    currentYear: 2026,
  });
  assert.equal(result.resultCount, 3);
  assert.equal(new URL(capturedUrl).searchParams.get('q'), '今天有什么新消息 2026');
  assert.match(result.context, /检索时间/);
  assert.match(result.context, /只是搜索引擎返回的标题和摘要/);
  assert.match(result.context, /来源域名：example\.com/);
});
