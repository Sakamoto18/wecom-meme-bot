import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNaturalnessRewriteHint,
  detectAssistantReportStyle,
} from '../src/naturalness.js';
import {
  buildNormalReplyRetryPrompt,
  reviewAttackReply,
  reviewNormalReply,
} from '../src/response-style.js';

test('识别 AI 报告腔、连接词堆叠和总结收尾', () => {
  const answer = '首先，这个方案要看兼容性。其次，还要看成本。另外，维护成本也不低。总的来说，我建议选第二个。希望这些对你有帮助。';
  const issues = detectAssistantReportStyle(answer, { compactResponse: true });
  assert.ok(issues.includes('assistant-connective-overload'));
  assert.ok(issues.includes('assistant-report-opening'));
  assert.ok(issues.includes('assistant-summary-closing'));

  const reviewed = reviewNormalReply(answer, {
    compactResponse: true,
    shortChat: true,
  });
  assert.ok(reviewed.issues.includes('assistant-connective-overload'));
  const retry = buildNormalReplyRetryPrompt('选哪个', answer, reviewed.issues, {
    compactResponse: true,
    shortChat: true,
  });
  assert.match(retry, /报告连接词/);
  assert.match(retry, /找不到贴合点就正常说/);
  assert.match(buildNaturalnessRewriteHint(['assistant-meta-voice']), /自我说明/);
});

test('明确要求文章时不用自然度规则误伤结构', () => {
  assert.deepEqual(
    detectAssistantReportStyle('首先写背景，其次写原因，最后总结。', {
      detailedAnswerRequested: true,
      compactResponse: false,
    }),
    [],
  );
});

test('连续三条普通回复使用同一开头时要求换起句', () => {
  const reviewed = reviewNormalReply('不是哥们，这方案还是先别上线。', {
    compactResponse: true,
    shortChat: true,
    history: [
      { role: 'assistant', content: '不是哥们，这接口已经挂了。' },
      { role: 'assistant', content: '不是哥们，这日志没法看。' },
    ],
  });
  assert.ok(reviewed.issues.includes('repeated-opening'));
});

test('带历史消歧包装的机器人回复按正文判断重复开头', () => {
  const envelope = (reply) => [
    '【机器人群聊回复记录】',
    '本轮回复对象：群友（成员-abcdef）',
    '本轮回复对象QQ号（仅供历史消歧）：1079175957',
    `机器人回复：${reply}`,
  ].join('\n');
  const reviewed = reviewNormalReply('不是哥们，这次又是接口挂了？', {
    compactResponse: true,
    shortChat: true,
    history: [
      { role: 'assistant', content: envelope('不是哥们，这接口已经挂了。') },
      { role: 'assistant', content: envelope('不是哥们，这日志没法看。') },
    ],
  });
  assert.ok(reviewed.issues.includes('repeated-opening'));

  const varied = reviewNormalReply('这次接口又挂了？', {
    compactResponse: true,
    shortChat: true,
    history: [
      { role: 'assistant', content: envelope('先把报错贴出来。') },
      { role: 'assistant', content: envelope('那就别急着上线。') },
    ],
  });
  assert.ok(!varied.issues.includes('repeated-opening'));
});

test('攻击复核不再强制亲属或人身骂词，但会拦截与当前话题无关的比喻', () => {
  const direct = reviewAttackReply('你这脑子今天没开机？', {
    userContent: '你是不是没睡醒',
  });
  assert.equal(direct.valid, true);

  const detached = reviewAttackReply('你这问题问得跟拿菜单点体检报告一样。', {
    userContent: 'B站 P2 怎么抓',
  });
  assert.ok(detached.issues.includes('detached-analogy'));

  const grounded = reviewAttackReply('你连 P2 都找不到，跟没开显示器一样。', {
    userContent: 'B站 P2 怎么抓',
  });
  assert.ok(!grounded.issues.includes('detached-analogy'));
});
