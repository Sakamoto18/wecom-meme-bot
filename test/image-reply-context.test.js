import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImageSearchPlan,
  buildImageSearchQueries,
  classifyImageAnalysis,
  classifyImageInformation,
  IMAGE_MEANING_PROMPT,
  isArtAppraisalIntent,
  isImageEvaluationIntent,
  isExplicitImageInterpretationIntent,
  isPureCharacterImage,
  shouldSkipCharacterEvaluation,
} from '../src/image-reply-context.js';
import { generateConversationReply } from '../src/reply-engine.js';
import { QqBotService, normalizeQqPayload } from '../src/qq-service.js';

const answer = '这图是在讽刺各自发明新标准反而制造更多标准，再统一一次就凑齐第十五套了。';

test('只有明确赏析画作时进入单句画面判断模式', () => {
  assert.equal(isArtAppraisalIntent('赏析一下这幅奶蛙画'), true);
  assert.equal(isArtAppraisalIntent('如何评价这张表情包'), false);
  assert.equal(isArtAppraisalIntent('这张视频封面是什么平台'), false);
});

test('带图的语义提问即使不写“这张图”也保留原始像素给最终模型', () => {
  assert.equal(isExplicitImageInterpretationIntent('明总如何评价'), true);
  assert.equal(isExplicitImageInterpretationIntent('你怎么选'), true);
  assert.equal(isExplicitImageInterpretationIntent('看看这图'), true);
  assert.equal(isExplicitImageInterpretationIntent('调侃一下这张电竞截图的地狱笑话'), true);
  assert.equal(isExplicitImageInterpretationIntent('晚上吃什么'), false);
});

test('画作赏析提示要求一个主体关系和一句话落点', async () => {
  const calls = [];
  const result = await generateConversationReply({
    content: '赏析一下这幅奶蛙画',
    currentQuestion: '赏析一下这幅奶蛙画',
    modelInput: '图片描述：奶蛙群体与墙上单独一只奶蛙',
    hasImageContext: true,
    artAppraisal: true,
    imageSearchQueries: [],
    webSearchEnabled: false,
    chatClient: { isConfigured: true, async complete(_history, _input, options) {
      calls.push(options);
      return '群体在麻木同行，唯独高墙上的脱队者在孤独思考蛙生。(¬◡¬)';
    } },
  });
  assert.equal(result.answer, '群体在麻木同行，唯独高墙上的脱队者在孤独思考蛙生。(¬◡¬)');
  assert.match(calls[0].additionalSystemPrompt, /短句画面赏析/);
  assert.match(calls[0].stableSystemPrompt, /18～55/);
  assert.match(calls[0].stableSystemPrompt, /第一句先像群友接梗一样下判断/);
});

test('图片检索限定具体线索，去重并限制查询预算，不把整段 OCR 发给搜索', () => {
  const queries = buildImageSearchQueries({ items: [
    { visibleText: ['整段私人对话，不应上传，但这里还有明确的漫画台词'], searchQueries: ['xkcd Standards', 'xkcd Standards'] },
    { visibleText: ['This is fine KC Green 的漫画台词和完整上下文'], searchQueries: ['This is fine KC Green', 'Distracted boyfriend'] },
    { searchQueries: ['fourth topic'] },
  ] }, '这几个是什么梗');
  assert.deepEqual(queries, ['xkcd Standards 来源 含义', 'This is fine KC Green 来源 含义']);
});

test('调侃电竞截图时优先用可见正文构造精确背景查询', () => {
  const queries = buildImageSearchQueries({ items: [{
    visibleText: ['9哥的今年冠军皮肤', '替父从军 花木兰 未解锁', '嫉妒你的才华'],
    description: '电竞评论截图，包含冠军皮肤和评论关系',
    scene: '评论区截图',
    keywords: ['电竞', '冠军皮肤'],
    searchQueries: [],
  }] }, '调侃LOL选手369的电竞地狱笑话');
  assert.equal(queries.length, 1);
  assert.match(queries[0], /9哥的今年冠军皮肤/);
  assert.match(queries[0], /替父从军/);
});

test('没有固定梗名时用场景关系和笑点机制构造一次语境查询', () => {
  const queries = buildImageSearchQueries({ items: [{
    visibleText: [],
    sceneRelation: '正经服务和荒诞装扮被并置',
    impliedPoint: '越周到越像在办黑活',
    comicMechanism: '身份错位与反差',
    replyHook: '服务员突然转职暗号交易员',
    keywords: ['服务', '暗号'],
  }] }, '笑点解析');
  assert.equal(queries.length, 1);
  assert.match(queries[0], /暗号/);
  assert.match(queries[0], /语境|含义|背景/);
});

test('视觉明确没有公开线索、识别失败或用户不允许联网时，不发空泛查询', () => {
  assert.deepEqual(buildImageSearchQueries({ items: [{ keywords: ['私聊'], searchQueries: [] }] }), []);
  assert.deepEqual(buildImageSearchQueries(null, '这是什么'), []);
  assert.deepEqual(buildImageSearchQueries({ keywords: ['xkcd'] }, '不要联网，只读图'), []);
  assert.deepEqual(buildImageSearchQueries({ searchQueries: ['https://example.com/steal', 'QQ 123456789'] }), []);
});

test('无文字或纯情绪梗图和低密度图片一律不搜索', () => {
  assert.deepEqual(buildImageSearchQueries({ items: [
    { searchQueries: ['哈哈哈哈'], visibleText: [], keywords: ['表情包'] },
    { searchQueries: ['猫咪 反应图'], visibleText: [], keywords: ['猫咪', '反应图'] },
  ] }, '看看这图'), []);
  assert.deepEqual(buildImageSearchQueries({ searchQueries: ['表情包'] }, '这是什么梗'), []);
  assert.deepEqual(buildImageSearchQueries({ searchQueries: ['Distracted boyfriend'] }, '评价一下这图'), []);
  assert.deepEqual(buildImageSearchQueries({ searchQueries: ['This is fine KC Green'] }, '这是什么梗'), []);
  assert.equal(isImageEvaluationIntent('评价一下这张图'), true);
  assert.equal(isImageEvaluationIntent('找下这张截图的原帖'), false);
});

test('图片附件缺失时评价图片也不回退到通用联网搜索', async () => {
  let searches = 0;
  const result = await generateConversationReply({
    content: '评价一下这张图片',
    currentQuestion: '评价一下这张图片',
    modelInput: '用户请求评价图片，但当前图片附件不可用',
    hasImageContext: false,
    webSearchEnabled: true,
    webSearch: { async search() { searches += 1; throw new Error('must not search'); } },
    chatClient: { isConfigured: true, async complete() { return '这句先不联网，没图就别硬评。'; } },
  });
  assert.equal(searches, 0);
  assert.equal(result.searchAttempted, false);
  assert.equal(result.answer, '这句先不联网，没图就别硬评。');
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

test('明确正文或问题不因长度不足被归为低信息，未命中热词也不会伪装成热词', () => {
  const policy = classifyImageInformation({
    description: '社交平台评论截图，画面里有人询问角色出处',
    visibleText: ['这个瘦巴巴的奶龙出自什么动漫啊？'],
    keywords: ['角色出处', '评论截图'],
    scene: '评论区',
  });
  assert.equal(policy.level, 'informative_clue');
  assert.equal(policy.hotTopic, false);
  assert.equal(policy.hotTopics, false);
  assert.equal(policy.searchEligible, false);

  const noTopic = classifyImageInformation({
    description: '一段普通说明文字',
    visibleText: ['这是一段包含具体事实和问题的普通说明文字，请判断是否准确。'],
    keywords: ['普通说明'],
    scene: '截图',
  });
  assert.notEqual(noTopic.level, 'hot_topic');
  assert.equal(noTopic.hotTopic, false);
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

test('低信息 logo 图只有可见品牌线索或高置信来源时才检索', () => {
  const textClue = buildImageSearchQueries({ items: [{
    visibleText: ['B站'],
    keywords: ['logo'],
    searchQueries: ['B站 logo'],
  }] }, '这是谁家的logo');
  assert.deepEqual(textClue, ['B站 logo 事实核查']);

  const noClue = buildImageSearchQueries({ items: [{
    visibleText: [],
    keywords: ['logo'],
    searchQueries: ['B站 logo'],
  }] }, '这是谁家的logo');
  assert.deepEqual(noClue, []);

  const sourceClue = buildImageSearchQueries({ items: [{
    visibleText: [],
    keywords: ['logo'],
    searchQueries: [],
    sourceCandidates: [{
      platform: 'bilibili',
      confidence: 'high',
      evidence: '画面可见粉色播放器图标和哔哩哔哩字样',
    }],
  }] }, '这是谁家的logo');
  assert.deepEqual(sourceClue, ['bilibili']);
});

test('低信息图在真的假的问题下进入事实核验，而不是纯玩梗', async () => {
  let prompt = '';
  const result = await generateConversationReply({
    content: '真的假的',
    currentQuestion: '真的假的',
    modelInput: '图片可见文字：三个月后人类将进入2027年',
    hasImageContext: true,
    imageInformationLevel: 'low_information',
    jevStyle: { imageCultureNeeded: 0.9, seriousRequest: 0 },
    imageSearchQueries: ['三个月后 2027 事实核查'],
    now: Date.parse('2026-10-21T12:00:00+08:00'),
    webSearch: { async search() {
      return { context: '日历事实摘要', resultCount: 1, results: [], evidenceQuality: 'related-only' };
    } },
    chatClient: { isConfigured: true, async complete(_history, _input, options) {
      prompt = options.additionalSystemPrompt;
      return '按日历算，三个月后确实进入 2027 年；图是在拿时间夸张。';
    } },
  });
  assert.equal(result.answer, '按日历算，三个月后确实进入 2027 年；图是在拿时间夸张。');
  assert.match(prompt, /程序计算的相对时间/);
  assert.match(prompt, /2027-01-21/);
  assert.match(prompt, /求证优先/);
  assert.doesNotMatch(prompt, /图片互联网梗输出模式/);
});

test('低信息图的九天后追问会带日期线索进入事实核验', async () => {
  const queries = [];
  const result = await generateConversationReply({
    content: '9天后有什么事情',
    currentQuestion: '9天后有什么事情',
    modelInput: '图片可见文字：还有九天',
    hasImageContext: true,
    imageInformationLevel: 'low_information',
    imageSearchQueries: ['冯骥 还有九天'],
    now: Date.parse('2026-10-22T00:00:00Z'),
    webSearch: { async search(query) {
      queries.push(query);
      return { context: '2026-10-31 没有对应的游戏发售公告', resultCount: 1, results: [], evidenceQuality: 'related-only' };
    } },
    chatClient: { isConfigured: true, async complete() {
      return '先查当前日期对应的公开安排，不能拿图片里的旧倒计时直接当答案。';
    } },
  });
  assert.equal(result.factSearchAttempted, true);
  assert.match(queries[0], /2026-10-31/);
  assert.match(result.answer, /旧倒计时/);
});

test('纯二次元/游戏角色图不评价，但身份和出处问题仍放行', () => {
  const character = { items: [{
    subjectKind: 'game_character',
    description: '游戏 CG 里的蓝发长翼女性角色，画面是角色立绘和对话框',
    scene: '视觉小说游戏界面',
    visibleText: ['隐藏', '自动', '跳过', '水星号', '这些箭吗？嗯……让我想想该怎么解释。'],
    informationKind: 'unknown',
    textClaims: ['这些箭吗？嗯……让我想想该怎么解释。'],
    keywords: ['游戏角色', 'CG'],
  }] };
  assert.equal(isPureCharacterImage(character), true);
  assert.equal(shouldSkipCharacterEvaluation(character, '评价一下这张图'), true);
  assert.equal(shouldSkipCharacterEvaluation(character, '好看吗'), true);
  assert.equal(shouldSkipCharacterEvaluation(character, '这是谁'), false);
  assert.equal(shouldSkipCharacterEvaluation(character, '这是哪款游戏的角色'), false);
  assert.equal(shouldSkipCharacterEvaluation(character, '这个角色叫什么'), false);

  const newsCharacter = {
    items: [{
      ...character.items[0],
      realityAnchor: '某游戏厂商发布角色停服公告',
      informationKind: 'news',
    }],
  };
  assert.equal(shouldSkipCharacterEvaluation(newsCharacter, '评价一下'), false);

  const memeCharacter = {
    items: [{ ...character.items[0], memeClaim: '把角色立绘改成了某条现实新闻的配图' }],
  };
  assert.equal(shouldSkipCharacterEvaluation(memeCharacter, '评价一下'), false);
});

test('动漫头像的聊天截图不会被误判成纯角色图', () => {
  const chat = { items: [{
    description: '群聊截图，头像和发言都是二次元角色相关',
    visibleText: ['甲：这个角色是谁', '乙：我也不知道'],
    keywords: ['动漫角色', '聊天截图'],
  }] };
  assert.equal(isPureCharacterImage(chat), false);
});

test('图片回答提示保留纯角色图不评价的兜底规则', () => {
  assert.match(IMAGE_MEANING_PROMPT, /纯二次元或游戏角色图/);
  assert.match(IMAGE_MEANING_PROMPT, /不评价颜值、身材、可爱程度或角色魅力/);
  assert.match(IMAGE_MEANING_PROMPT, /身份、作品或出处/);
});

test('现实新闻与私钥规则会生成优先的公网检索线索', () => {
  const phpPlan = buildImageSearchPlan({
    items: [{
      realityAnchor: 'PHP2Shell 漏洞',
      informationKind: 'news',
    }],
  }, '昨天的php漏洞是个什么情况没看懂什么意思');
  assert.match(phpPlan[0].query, /PHP2Shell/);
  assert.match(phpPlan[0].query, /昨天的php漏洞/);
  assert.match(phpPlan[0].query, /新闻|事件|原因|背景/);

  const keyPlan = buildImageSearchPlan({
    items: [{
      realityAnchor: 'ECDSA 私钥',
      informationKind: 'technical_rule',
    }],
  }, '不是，你不能解释一下为什么这个4就是完整密钥了啊？？？');
  assert.match(keyPlan[0].query, /4/);
  assert.match(keyPlan[0].query, /完整密钥|私钥|规则|合法范围/);

  const ocrNoise = '这是一整段很长的 OCR 噪声文字，不应该被原样拼进检索查询。'.repeat(20);
  const noisyPlan = buildImageSearchPlan({
    items: [{
      realityAnchor: 'PHP2Shell 漏洞',
      visibleText: [ocrNoise],
    }],
  }, '昨天的php漏洞是怎么回事');
  assert.doesNotMatch(noisyPlan[0].query, /OCR 噪声文字/);
});
