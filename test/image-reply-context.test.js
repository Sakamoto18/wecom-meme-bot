import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImageSearchQueries } from '../src/image-reply-context.js';
import { generateConversationReply } from '../src/reply-engine.js';

const answer = '这图是在讽刺各自发明新标准反而制造更多标准，再统一一次就凑齐第十五套了。';

test('图片检索限定具体线索，去重并限制最多三条，不把整段 OCR 发给搜索', () => {
  const queries = buildImageSearchQueries({ items: [
    { visibleText: ['整段私人对话，不应上传'], searchQueries: ['xkcd Standards', 'xkcd Standards'] },
    { searchQueries: ['This is fine KC Green', 'Distracted boyfriend'] },
    { searchQueries: ['fourth topic'] },
  ] }, '这几个是什么梗');
  assert.deepEqual(queries, ['xkcd Standards 来源 含义', 'This is fine KC Green 来源 含义', 'Distracted boyfriend 来源 含义']);
});

test('视觉明确没有公开线索、识别失败或用户不允许联网时，不发空泛查询', () => {
  assert.deepEqual(buildImageSearchQueries({ items: [{ keywords: ['私聊'], searchQueries: [] }] }), []);
  assert.deepEqual(buildImageSearchQueries(null, '这是什么'), []);
  assert.deepEqual(buildImageSearchQueries({ keywords: ['xkcd'] }, '不要联网，只读图'), []);
  assert.deepEqual(buildImageSearchQueries({ searchQueries: ['https://example.com/steal', 'QQ 123456789'] }), []);
});

test('图片线索走真实搜索接口，结果进入自然解释提示，人格生成路径保留', async () => {
  const searches = [], modelCalls = [];
  const result = await generateConversationReply({
    content: '看看这图', modelInput: '图片可见文字：14 competing standards',
    hasImageContext: true, imageSearchQueries: ['xkcd Standards 927 含义 背景'],
    webSearch: { async search(query, options) {
      searches.push({ query, options });
      return { context: 'xkcd.com：Standards，第 927 话', resultCount: 1, query, results: [], endpoint: 'https://example.com/search' };
    } },
    chatClient: { isConfigured: true, async complete(history, input, options) {
      modelCalls.push({ history, input, options }); return answer;
    } },
  });
  assert.equal(searches.length, 1);
  assert.equal(searches[0].options.usageSource, 'web-search-image');
  assert.equal(result.searchAttempted, true);
  assert.match(modelCalls[0].options.additionalSystemPrompt, /xkcd.com：Standards/);
  assert.match(modelCalls[0].options.additionalSystemPrompt, /不要照抄内部/);
  assert.match(modelCalls[0].options.additionalSystemPrompt, /继续使用现有聊天人格/);
  assert.ok(modelCalls[0].options.stableSystemPrompt);
  assert.equal(modelCalls[0].options.usageSource, 'conversation-reply');
  assert.equal(result.answer, answer);
});

test('多主题搜索局部失败保留其他证据，全部失败仍生成图片回答', async () => {
  for (const allFail of [false, true]) {
    let prompt = '';
    const result = await generateConversationReply({
      content: '这两张图是什么意思', modelInput: '图一与图二', hasImageContext: true,
      imageSearchQueries: ['first clue', 'second clue'],
      webSearch: { async search(query) {
        if (allFail || query === 'first clue') throw new Error('检索超时');
        return { context: '第二条线索的可用证据', resultCount: 1, results: [] };
      } },
      chatClient: { isConfigured: true, async complete(_history, _input, options) { prompt = options.additionalSystemPrompt; return answer; } },
    });
    assert.equal(result.answer, answer);
    assert.ok(result.searchError);
    assert.equal(result.searchResult.resultCount, allFail ? 0 : 1);
    assert.match(prompt, allFail ? /检索超时/ : /第二条线索的可用证据/);
  }
});

test('无可靠图片线索时不回退搜索“看看这图”，也不宣称联网成功', async () => {
  let prompt = '';
  const result = await generateConversationReply({
    content: '看看这图', modelInput: '看不清', hasImageContext: true, imageSearchQueries: [],
    webSearch: { search() { throw new Error('must not search'); } },
    chatClient: { isConfigured: true, async complete(_history, _input, options) { prompt = options.additionalSystemPrompt; return answer; } },
  });
  assert.equal(result.searchAttempted, false);
  assert.match(prompt, /未进行图片联网查询/);
});


test('带图的选择题直接回答，识别资料不变成必输出的描述', async () => {
  const calls = [];
  const choice = '我选学校，联网当工具就行；别把刷资料当成亲自学会了。';
  const result = await generateConversationReply({
    content: '你怎么选', modelInput: '图片描述：左边是学校，右边是网吧。当前消息：你怎么选',
    hasImageContext: true, imageSearchQueries: [],
    chatClient: {isConfigured:true, async complete(h, i, o) {calls.push(o); return choice;}},
    webSearchEnabled: false,
  });
  assert.equal(result.answer, choice);
  assert.equal(calls.length, 1);
  assert.match(calls[0].additionalSystemPrompt, /图片只是证据/);
  assert.match(calls[0].additionalSystemPrompt, /本轮用户当前问题.*你怎么选/);
  assert.doesNotMatch(calls[0].additionalSystemPrompt, /默认解释这张图在表达/);
});
