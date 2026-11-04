import test from 'node:test';
import assert from 'node:assert/strict';
import { stripReplyActing, REPLY_EXPRESSION_PROMPT } from '../src/reply-expression.js';
import { generateConversationReply } from '../src/reply-engine.js';
import { buildMessages } from '../src/chat-client.js';
import { normalizeTurnPlan } from '../src/reply-turn-planner.js';
import { buildModelInput, getGroupInteractionContext } from '../src/message-utils.js';

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
