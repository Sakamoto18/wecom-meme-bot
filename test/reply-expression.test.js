import test from 'node:test';
import assert from 'node:assert/strict';
import { stripReplyActing, REPLY_EXPRESSION_PROMPT, hasReplyProcessNarration, removeReplyProcessNarration, guardFinalReply } from '../src/reply-expression.js';
import { generateConversationReply } from '../src/reply-engine.js';
import { buildMessages } from '../src/chat-client.js';
import { normalizeTurnPlan } from '../src/reply-turn-planner.js';
import { buildModelInput, getGroupInteractionContext } from '../src/message-utils.js';

const screenshotDraft = '“女拳”标签上，那我得先拆开：各人有各人的成名路，节目只是把这四个嘴上功夫厉害的凑一桌。';

test('带引号、嵌套括号和代码片段的内心戏必须整体移除，不能留下截图尾巴', () => {
  const answer = '竞争对手也可能在某些产品上存在供应关系。';
  for (const inner of [
    '（心想：不能直接说“欣旺达买宁德电芯”，得说实话。）',
    '(内心OS：不能直接说"欣旺达买宁德电芯"，得说实话。)',
    '（心想：要核实（采购的是哪类产品），`不能乱说`。）',
    '（心想：先看“客户”指什么。\n再回答。）',
  ]) assert.equal(guardFinalReply(inner + '\n' + answer), answer);
  assert.equal(guardFinalReply('“欣旺达买宁德电芯”，得说实话。)'), '');
  assert.equal(guardFinalReply('（心想：没写完“引用”'), '');
  assert.equal(guardFinalReply('“（心想：引用原文。）”是心理描写。'), '“（心想：引用原文。）”是心理描写。');
  assert.equal(guardFinalReply('```js\ntext = "（心想：原文）";\n```'), '```js\ntext = "（心想：原文）";\n```');
});

test('沉浸指令不再要求括号独白，原截图残句触发完整重写', async () => {
  const calls = [];
  const result = await generateConversationReply({
    content: '欣旺达为什么也是宁德时代客户', modelInput: '欣旺达为什么也是宁德时代客户',
    roleplayImmersion: true, webSearchEnabled: false,
    chatClient: { isConfigured: true, async complete(_history, input, options) {
      calls.push(options.usageSource);
      assert.doesNotMatch(String(input), /请以角色第一人称进行内心独白|用括号包裹内心活动/);
      return options.usageSource === 'reply-expression-repair' ? '客户和竞争对手这两种关系可以同时存在，具体采购关系还要核实。' : '“欣旺达买宁德电芯”，得说实话。)';
    } },
  });
  assert.ok(calls.includes('reply-expression-repair'));
  assert.doesNotMatch(result.answer, /得说实话|[)）]/);
});

test('截图分析旁白和思考标签被识别，引用、代码和实际步骤保留', () => {
  for (const text of [screenshotDraft, '让我想想该怎么回。', '我先分析一下你的话。', '这句我要接什么梗呢？', '先判断用户意图。', '<think>准备接梗</think>直接回复。']) {
    assert.equal(hasReplyProcessNarration(text), true, text);
    assert.equal(hasReplyProcessNarration(removeReplyProcessNarration(text)), false, text);
  }
  for (const text of ['“那我得先拆开”这句是旁白。', '`我先分析一下`', '> 我先分析一下。', '先断电，再拆开机箱。', '我觉得这个说法没依据。', '结论有两个原因：数据少，样本也有偏差。']) {
    assert.equal(hasReplyProcessNarration(text), false, text);
    assert.equal(removeReplyProcessNarration(text), text);
  }
  assert.equal(removeReplyProcessNarration(screenshotDraft + '不能仅凭这个标签判断。'), '不能仅凭这个标签判断。');
});

for (const scenario of [
  { content: '那你就说这四个出圈不是因为女拳的事情？吓哭了', hasImageContext: true },
  { content: '你个傻逼' },
  { content: '今天又加班', activeReply: true },
  { content: '@机器人', pureBotMention: true },
  { content: '许飞和厉娜是什么', turnPlan: normalizeTurnPlan({ search: { culture_needed: true, culture_queries: ['许飞 厉娜'] } }), videoLearningGate: () => ({ action: 'remind', topic: '许飞 厉娜' }) },
]) {
  test(`分析旁白在发出前整句修复：${scenario.content}`, async () => {
    let repairs = 0;
    const result = await generateConversationReply({
      ...scenario, modelInput: scenario.content, webSearchEnabled: false,
      chatClient: { isConfigured: true, async complete(_history, _input, options) {
        if (options.usageSource === 'reply-expression-repair') {
          repairs++;
          assert.equal(options.thinking.type, 'disabled');
          assert.equal(options.tools, undefined);
          return '不能仅凭这个标签判断。';
        }
        return screenshotDraft;
      } },
    });
    assert.ok(repairs > 0);
    assert.ok(result.answer.trim());
    assert.doesNotMatch(result.answer, /先拆开|标签上/);
  });
}

test('修复失败或仍输出旁白时，不发送原草稿或残句', async () => {
  for (const fail of [true, false]) {
    const result = await generateConversationReply({
      content: '那你就说这四个出圈不是因为女拳的事情？', modelInput: '说说这个节目', webSearchEnabled: false,
      chatClient: { isConfigured: true, async complete(_history, _input, options) {
        if (fail && options.usageSource === 'reply-expression-repair') throw new Error('timeout');
        return screenshotDraft + '不能仅凭这个标签判断。';
      } },
    });
    assert.equal(result.answer, '不能仅凭这个标签判断。');
  }
});

test('去掉截图中的表情、星号动作和内心戏，保留真正的台词', () => {
  for (const direction of ['（笑）', '(冷笑)', '*翻白眼*', '**摊手**', '（微微挑眉）', '（内心OS：先接话）']) {
    assert.equal(stripReplyActing(`${direction}这就把你吓哭了？`), '这就把你吓哭了？');
  }
  assert.equal(stripReplyActing('这就把你吓哭了？（笑）'), '这就把你吓哭了？');
  assert.equal(stripReplyActing('内心OS：先接话\n这就把你吓哭了？'), '这就把你吓哭了？');
});

test('保留事实括注、代码、引文和对动作本身的讨论', () => {
  for (const source of ['节目（后来改名）有四位嘉宾。', '“（笑）”是动作描写。', '「*翻白眼*」是原文。', '> （冷笑）\n这是原文。', '`（笑）`', '```js\nconst text = "（笑）";\n```', '（微笑是一种表情）', '看见就笑了。', '（补充说明：这是正式标题。）']) {
    assert.equal(stripReplyActing(source), source);
  }
});

for (const scenario of [
  { name: '普通识图', content: '我被这个女拳组合吓哭了', hasImageContext: true },
  { name: '主动回复', content: '今天的培训又要加班', activeReply: true },
  { name: '回击', content: '你个傻逼' },
  { name: '纯艾特', content: '@机器人', pureBotMention: true },
  { name: '学习提醒', content: '许飞和厉娜是什么', turnPlan: normalizeTurnPlan({ current_task: '解释许飞和厉娜', search: { culture_needed: true, culture_queries: ['许飞 厉娜'] } }), videoLearningGate: () => ({ action: 'remind', taskKey: 'fixture', topic: '许飞 厉娜' }) },
]) {
  for (const roleplayImmersion of [false, true]) {
    test(`${scenario.name}：沉浸=${roleplayImmersion} 时首稿和重写都服从基座`, async () => {
      const calls = [];
      const result = await generateConversationReply({
        ...scenario, roleplayImmersion, modelInput: scenario.content,
        priorityPersonaContext: '人格补充：可以带一个动作。', webSearchEnabled: false,
        chatClient: { isConfigured: true, async complete(history, input, options) {
          calls.push(options);
          const messages = buildMessages(history, input, options);
          assert.ok(messages.at(-2).content.endsWith(REPLY_EXPRESSION_PROMPT));
          return '（笑）你这点出息，*翻白眼*这就把你吓哭了？（内心OS：接住了）';
        } },
      });
      assert.ok(calls.length);
      assert.doesNotMatch(result.answer, /（笑）|翻白眼|内心OS/);
      assert.match(result.answer, /吓哭/);
    });
  }
}

test('非沉浸模式的正文只有动作时会重试，仍为空则用非空兜底', async () => {
  for (const retryAnswer of ['（冷笑）这就把你吓哭了？', '（笑）']) {
    let calls = 0;
    const result = await generateConversationReply({
      content: '今天忙完了', modelInput: '今天忙完了', webSearchEnabled: false,
      chatClient: { isConfigured: true, async complete() { calls++; return calls === 1 ? '（笑）' : retryAnswer; } },
    });
    assert.ok(calls >= 2);
    assert.ok(result.answer.trim());
    assert.doesNotMatch(result.answer, /（笑）|（冷笑）/);
  }
});

test('纠错重写仍带最终表达约束并清理新生成的动作', async () => {
  const content = '我问的是上传速度，不是下载';
  const oldAnswer = '下载速度先看下行带宽，下载快慢主要受它限制。';
  const message = { msgtype: 'text', chattype: 'group', from: { userid: 'sender' },
    bot_user_id: 'bot', bot_names: ['龙2号机'], mentions: [{ user_id: 'bot', name: '龙2号机' }],
    text: { content } };
  const calls = [];
  const result = await generateConversationReply({
    content, modelInput: buildModelInput(message, content), webSearchEnabled: false,
    interactionContext: getGroupInteractionContext(message),
    history: [{ role: 'user', content: '传文件为什么慢？' }, { role: 'assistant', content: oldAnswer }],
    turnPlan: normalizeTurnPlan({ current_task: '解释上传速度', topic_relation: 'correction', speech_act: 'correction_with_banter' }),
    chatClient: { isConfigured: true, async complete(history, input, options) {
      calls.push(options);
      assert.ok(buildMessages(history, input, options).at(-2).content.endsWith(REPLY_EXPRESSION_PROMPT));
      return calls.length === 1 ? oldAnswer : '（扶额）上传要看上行带宽，下载快不代表上传也快。';
    } },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.answer, '上传要看上行带宽，下载快不代表上传也快。');
});
