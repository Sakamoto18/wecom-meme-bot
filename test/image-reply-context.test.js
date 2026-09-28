import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImageSearchQueries,
  classifyImageAnalysis,
  classifyImageInformation,
} from '../src/image-reply-context.js';
import { generateConversationReply } from '../src/reply-engine.js';
import { QqBotService, normalizeQqPayload } from '../src/qq-service.js';

const answer = '这图是在讽刺各自发明新标准反而制造更多标准，再统一一次就凑齐第十五套了。';

test('图片检索限定具体线索，去重并限制查询预算，不把整段 OCR 发给搜索', () => {
  const queries = buildImageSearchQueries({ items: [
    { visibleText: ['整段私人对话，不应上传'], searchQueries: ['xkcd Standards', 'xkcd Standards'] },
    { searchQueries: ['This is fine KC Green', 'Distracted boyfriend'] },
    { searchQueries: ['fourth topic'] },
  ] }, '这几个是什么梗');
  assert.deepEqual(queries, ['xkcd Standards 来源 含义', 'This is fine KC Green 来源 含义']);
});

test('视觉明确没有公开线索、识别失败或用户不允许联网时，不发空泛查询', () => {
  assert.deepEqual(buildImageSearchQueries({ items: [{ keywords: ['私聊'], searchQueries: [] }] }), []);
  assert.deepEqual(buildImageSearchQueries(null, '这是什么'), []);
  assert.deepEqual(buildImageSearchQueries({ keywords: ['xkcd'] }, '不要联网，只读图'), []);
  assert.deepEqual(buildImageSearchQueries({ searchQueries: ['https://example.com/steal', 'QQ 123456789'] }), []);
});

test('无文字或纯情绪梗图默认不搜索，明确核实时也只接受具体线索', () => {
  assert.deepEqual(buildImageSearchQueries({ items: [
    { searchQueries: ['哈哈哈哈'], visibleText: [], keywords: ['表情包'] },
    { searchQueries: ['猫咪 反应图'], visibleText: [], keywords: ['猫咪', '反应图'] },
  ] }, '看看这图'), []);
  assert.deepEqual(buildImageSearchQueries({ searchQueries: ['表情包'] }, '这是什么梗'), []);
  assert.deepEqual(buildImageSearchQueries({ searchQueries: ['Distracted boyfriend'] }, '评价一下这图'), []);
  assert.deepEqual(buildImageSearchQueries({ searchQueries: ['This is fine KC Green'] }, '这是什么梗'), [
    'This is fine KC Green 来源 含义',
  ]);
});

test('水印、账号名和互动计数不会伪装成高密度信息图', () => {
  const item = {
    description: 'B站视频截图，画面右上角有账号名和点赞数',
    visibleText: ['哔哩哔哩', '某某UP主', '点赞 12.4万', '评论 392'],
    keywords: ['AI动物视频'],
    scene: '平台分享截图',
  };
  const policy = classifyImageInformation(item);
  assert.equal(policy.level, 'low_information');
  assert.equal(policy.searchEligible, false);
  assert.deepEqual(buildImageSearchQueries({ items: [{
    ...item,
    searchQueries: ['AI动物视频 B站 原视频'],
  }] }, '评价一下这张图'), []);
});

test('长文、论坛和多格漫画达到严格信息密度后才允许搜索', () => {
  const policy = classifyImageAnalysis({ items: [{
    description: '论坛评论区的长文讨论，包含多个观点和结论',
    visibleText: [
      '第一层：这个方案在高峰期间会导致大量请求排队。',
      '第二层：缓存命中率下降的原因需要看输入前缀是否稳定。',
      '第三层：建议先拆分动态上下文，再观察实际命中率。',
      '第四层：如果仍然异常，再检查供应商缓存策略。',
    ],
    keywords: ['缓存', '高峰', '请求'],
    scene: '论坛评论区',
    searchQueries: ['缓存命中率 高峰 请求'],
  }] });
  assert.equal(policy.level, 'high_density');
  assert.equal(policy.searchEligible, true);
});

test('热词必须同时有上下文，单独出现在水印中不会触发搜索', () => {
  assert.equal(classifyImageInformation({
    visibleText: ['小红书', '点赞 23'],
    description: '小红书分享封面',
  }).level, 'low_information');
  assert.equal(classifyImageInformation({
    visibleText: ['最近人工智能模型的价格又调整了，开发者需要重新核算成本。'],
    description: '一段关于人工智能的价格公告',
    scene: '公告截图',
  }).level, 'hot_topic');
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

test('引用 Bot 自己生成的视频封面时直接说明不评价，不进入视觉和联网搜索', async () => {
  const payload = normalizeQqPayload({
    message_type: 'group', group_id: 'g', user_id: 'u', bot_user_id: 'bot',
    text: '评价一下这张图', quoted_user_id: 'bot',
    quoted_image_base64s: ['aGVsbG8='], quoted_image_sub_types: ['0'],
    quoted_bot_generated_image: true, bot_generated_image_only: true,
    has_image: true,
  });
  assert.equal(payload.hasImage, false);
  const service = new QqBotService({});
  const result = await service.handleNormalizedMessage(payload);
  assert.deepEqual(result.messages, [{
    type: 'text',
    text: '这是我抓取视频生成的封面卡片，只用于传递视频信息，不评价这张图。',
  }]);
});
