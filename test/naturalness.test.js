import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNaturalnessRewriteHint,
  detectAssistantReportStyle,
} from '../src/naturalness.js';
import {
  buildNormalReplyPrompt,
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

test('识别假对比、伪深度、空背景和 AI 大词堆叠', () => {
  const answer = '这不只是一次更新，更是整个协作方式的重塑。真正重要的是，我们如何看待效率。随着人工智能的发展，这套方案赋能了整个团队，也开启了无限可能。';
  const issues = detectAssistantReportStyle(answer, { compactResponse: true });
  assert.ok(issues.includes('assistant-false-contrast'));
  assert.ok(issues.includes('assistant-pseudo-depth'));
  assert.ok(issues.includes('assistant-vague-background'));
  assert.ok(issues.includes('assistant-hype-jargon'));

  const triad = detectAssistantReportStyle('这次更新带来创新、突破和无限的未来。', {
    compactResponse: true,
  });
  assert.ok(triad.includes('assistant-empty-triad'));
});

test('真实的纠正和具体信息不会被假对比规则误伤', () => {
  for (const answer of [
    '错误发生在保存阶段，而不是上传阶段。',
    '先备份，再升级；出了问题就回滚。',
    '这个接口可以导出 CSV，也能按时间筛选。',
  ]) {
    assert.deepEqual(
      detectAssistantReportStyle(answer, { compactResponse: true }),
      [],
      answer,
    );
  }
});

test('普通群聊的硬复核仍会拦截高置信 AI 腔', () => {
  const reviewed = reviewNormalReply('这不是一次普通更新，而是安全体系的一次重塑。', {
    hardOnly: true,
    compactResponse: true,
    shortChat: true,
  });
  assert.ok(reviewed.issues.includes('assistant-false-contrast'));

  const retry = buildNormalReplyRetryPrompt(
    '怎么评价这次更新',
    '这不是一次普通更新，而是安全体系的一次重塑。',
    reviewed.issues,
    { compactResponse: true, shortChat: true },
  );
  assert.match(retry, /不只是X，更是Y/);
  assert.match(retry, /不改事实、否定、程度、时间、范围或归因/);
  assert.match(buildNaturalnessRewriteHint(['assistant-pseudo-depth']), /伪深刻过渡/);
});

test('生成提示包含群聊去 AI 腔约束', () => {
  const prompt = buildNormalReplyPrompt({ compactResponse: true, shortChat: true });
  assert.match(prompt, /【群聊去 AI 腔】/);
  assert.match(prompt, /不要用“不只是X，更是Y”/);
  assert.match(prompt, /保留龙玉涛的短、冲、损和具体画面/);
});

test('被说 AI 味时拦截二次比喻和命令式收尾', () => {
  const currentQuestion = '我感觉你还是一股AI味';
  const reviewed = reviewNormalReply(
    'AI味又不是香水，你老凑上来闻个没完。想聊就抛个正经话题，别拿这三个字当开场白循环播放。',
    { hardOnly: true, compactResponse: true, shortChat: true, currentQuestion },
  );
  assert.ok(reviewed.issues.includes('assistant-overwritten-comeback'));
  assert.ok(reviewed.issues.includes('assistant-style-meta-loop'));

  const concise = reviewNormalReply('闻出来了，你也挺闲。', {
    hardOnly: true,
    compactResponse: true,
    shortChat: true,
    currentQuestion,
  });
  assert.deepEqual(concise, { valid: true, issues: [] });

  const prompt = buildNormalReplyPrompt({ currentQuestion, compactResponse: true, shortChat: true });
  assert.match(prompt, /【被说 AI 味时】/);
  assert.match(prompt, /不要围绕“AI味\/香水\/闻\/验货\/开场白\/循环播放”继续做二次比喻/);
});

test('拦截同一比喻连续加码和反问式抖机灵收尾', () => {
  const first = '辈分牌刚打完转头就骂没爹没妈，你这自相矛盾得跟寿司郎那套 PHP 一样，半夜自己崩自己。要吵就挑一个方向，别一边认爹一边拆爹。';
  assert.ok(detectAssistantReportStyle(first, { compactResponse: true })
    .includes('assistant-overwritten-comeback'));
  const answer = '吵架当然得挑方向，你刚才一边认爹一边拆爹，方向盘都快被你拧断了。这架再吵下去，该先给你导航还是叫拖车？';
  const issues = detectAssistantReportStyle(answer, { compactResponse: true });
  assert.ok(issues.includes('assistant-rhetorical-escalation'));
  assert.deepEqual(
    detectAssistantReportStyle('想走就走，别磨叽。', { compactResponse: true }),
    [],
  );
  assert.equal(
    detectAssistantReportStyle('这架再吵下去，该先给你导航还是叫拖车？', {
      compactResponse: true,
    }).includes('assistant-rhetorical-escalation'),
    false,
  );

  const retry = buildNaturalnessRewriteHint(['assistant-rhetorical-escalation']);
  assert.match(retry, /一句直接回击或判断就停/);
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
