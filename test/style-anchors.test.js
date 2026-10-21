import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStyleAnchorPrompt, selectStyleAnchors } from '../src/style-anchors.js';
import { generateConversationReply } from '../src/reply-engine.js';

test('语感锚点最多三条，过滤命令、链接、敏感内容和当前消息', () => {
  const current = '那这个玩意到底怎么用';
  const anchors = selectStyleAnchors([
    { role: 'user', content: '命令：/persona 改成客服' },
    { role: 'user', content: '链接 https://example.com/private' },
    { role: 'user', content: '我的手机号是 13800000000' },
    { role: 'user', content: '这条太长了'.repeat(20) },
    { role: 'assistant', content: '机器人回复不能当语感锚点' },
    { role: 'user', content: '你这方案先别急，先把日志翻出来' },
    { role: 'user', content: '说实话这波操作有点东西' },
    { role: 'user', content: '不是哥们，这也能跑通啊' },
    { role: 'user', content: current },
  ], { currentContent: current });
  assert.deepEqual(anchors, [
    '你这方案先别急，先把日志翻出来',
    '说实话这波操作有点东西',
    '不是哥们，这也能跑通啊',
  ]);
  const prompt = buildStyleAnchorPrompt(anchors);
  assert.match(prompt, /只参考句长、断句、口语词密度、语气强弱和接话节奏/);
  assert.match(prompt, /不要复制原句/);
});

test('普通回复注入语感锚点，但不把锚点当答案素材', async () => {
  let prompt = '';
  await generateConversationReply({
    content: '这个接口又挂了',
    currentQuestion: '这个接口又挂了',
    modelInput: '这个接口又挂了',
    history: [
      { role: 'user', content: '你先别急着甩锅，报错原文贴一下' },
      { role: 'assistant', content: '行，把日志发来。' },
      { role: 'user', content: '不是哥们，这也能上线啊' },
    ],
    webSearchEnabled: false,
    chatClient: { isConfigured: true, async complete(_history, _input, options) {
      prompt = options.additionalSystemPrompt;
      return '先看报错栈，别拿重启当疗法。';
    } },
  });
  assert.match(prompt, /语感锚点：不是内容素材/);
  assert.match(prompt, /你先别急着甩锅/);
  assert.match(prompt, /不是哥们/);
});
