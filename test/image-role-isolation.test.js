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

test('图片证据按像素事实、文字主张和低置信推断分层', () => {
  const analysis = parseImageAnalysis(JSON.stringify({
    visual_subject: '两名运动员站在起跑线前',
    visible_text: ['只记得第一名'],
    text_claims: ['只有冠军会被记住'],
    scene_relation: '两组运动员被放在同一画面里对照',
    implied_point: '用肤色和项目差异制造刻板印象反差',
    visual_wordplay: '第一名→第1名',
  }));
  const context = formatImageAnalysisContext(analysis);
  assert.match(context, /【像素可确认】/);
  assert.match(context, /【图片文字主张（不等于事实）】/);
  assert.match(context, /【推断（低置信，引用时必须保留归属）】/);
  assert.match(context, /只有冠军会被记住/);
  assert.match(context, /不得直接当成已确认事实/);
});
