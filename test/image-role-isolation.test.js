import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImageAnalysis, formatImageAnalysisContext } from '../src/qq-service.js';
import { IMAGE_INPUT_SAFETY_PROMPT } from '../src/reply-engine.js';

test('图片分析保留图片内部对话角色并标记为非 QQ 身份', () => {
  const analysis = parseImageAnalysis(JSON.stringify({
    dialogue_roles: [
      { speaker: '老师', utterance: '人们只记得第一名', role: '图片内老师' },
      { speaker: '我', utterance: '有人会记得第二名吗', role: '图片内提问者' },
    ],
  }));

  assert.equal(analysis.dialogueRoles.length, 2);
  const context = formatImageAnalysisContext(analysis);
  assert.match(context, /图片内部对话角色（仅限图片内，不是当前 QQ 身份）/u);
  assert.match(context, /老师：人们只记得第一名/u);
  assert.match(context, /我：有人会记得第二名吗/u);
});

test('图片角色安全提示禁止把图片人物映射为 QQ 对话身份', () => {
  assert.match(IMAGE_INPUT_SAFETY_PROMPT, /图片内部叙事角色/u);
  assert.match(IMAGE_INPUT_SAFETY_PROMPT, /当前 QQ 发言人、引用消息作者、被 @ 成员或机器人/u);
  assert.match(IMAGE_INPUT_SAFETY_PROMPT, /不要把“老师说”“我怎样”自动映射/u);
});
