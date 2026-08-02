import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttackPrompt,
  buildNormalReplyPrompt,
  buildSeriousReplyRetryPrompt,
  containsLiteralLatinMa,
  isThinSeriousReply,
  isHostileContent,
  removeInternalParticipantIds,
  reviewAttackReply,
  selectAttackScene,
  shouldSearchLongtuKnowledge,
  shouldUseThinking,
  shouldUseAttackStyle,
} from '../src/response-style.js';

test('发送回复前隐藏内部群成员编号', () => {
  assert.equal(
    removeInternalParticipantIds('至高无上的真龙王（成员-ede6ee）'),
    '至高无上的真龙王',
  );
  assert.equal(
    removeInternalParticipantIds('成员-ede6ee，身份不会改变'),
    '这位群友，身份不会改变',
  );
  assert.equal(
    removeInternalParticipantIds('群成员-ede6ee说得对'),
    '这位群友说得对',
  );
});

test('识别明确辱骂和 ma 音变体', () => {
  for (const content of [
    '来让我看看你的攻击性，废物',
    'nmsl',
    '滚开',
    '你老冯没了',
    '死老冯',
    '你老冯早就寄了',
    '妈死了',
    '你妈没了',
    '你可真司马',
    '带上你🐎滚',
    '你码',
    '你麻呢',
    '尼玛',
    'nima',
    'ma',
    '卧槽丝你的妈',
    '卧槽丝你的吗',
    '我草死你🐎',
    '@真正的龙玉涛 卧槽丝你的吗',
  ]) {
    assert.equal(isHostileContent(content), true, content);
  }
});

test('不把普通同音词、历史人物和丧亲陈述当成攻击', () => {
  for (const content of [
    '我妈今天过生日',
    '我妈去世了',
    '司马迁是谁',
    '司马懿是哪里人',
    '冯老师今天上课',
    '帮我解释一下滚动事件',
    '你马上来一下',
    '这段代码怎么改',
    '我的号码是多少',
    '你在干嘛',
    '你码字真快',
    '卧槽，这是你的吗',
    '这个文件是你的吗',
  ]) {
    assert.equal(isHostileContent(content), false, content);
  }
});

test('对线语境可延续一轮，但明确降级时停止攻击', () => {
  const history = [
    { role: 'user', content: '你妈死了' },
    { role: 'assistant', content: '你🐎的旧帖还在坟头翻页呢。' },
  ];
  assert.equal(shouldUseAttackStyle('你的输出结果是哪里来的', history), true);
  assert.equal(shouldUseAttackStyle('认真回答，别骂了', history), false);
  assert.equal(shouldUseAttackStyle('今天天气怎么样', history), false);
});

test('只在用户询问龙图出处或含义时触发联网资料', () => {
  assert.equal(shouldSearchLongtuKnowledge('龙玉涛是什么梗'), true);
  assert.equal(shouldSearchLongtuKnowledge('联网搜索龙图语录'), true);
  assert.equal(shouldSearchLongtuKnowledge('你妈死了'), false);
  assert.equal(shouldSearchLongtuKnowledge('今天天气怎么样'), false);
});

test('正经问题开启思考，攻击和简单闲聊保持快速模式', () => {
  assert.equal(shouldUseThinking('我有四个千兆设备，应该使用什么网络方案'), true);
  assert.equal(shouldUseThinking('这段代码为什么报错，应该怎么解决'), true);
  assert.equal(shouldUseThinking('司马迁是谁'), true);
  assert.equal(shouldUseThinking('你好'), false);
  assert.equal(shouldUseThinking('说话！'), false);
  assert.equal(shouldUseThinking('你妈死了'), false);
});

test('正经问答提示不受群聊短句限制，并检测内容单薄的答案', () => {
  const prompt = buildNormalReplyPrompt({ thinkingEnabled: true });
  assert.match(prompt, /不要为了群聊节奏压缩答案/);
  assert.match(prompt, /比较主要备选项/);
  assert.doesNotMatch(prompt, /通常 1～3 句/);

  assert.equal(isThinSeriousReply('建议用 exFAT，三个系统都能用。'), true);
  assert.equal(isThinSeriousReply([
    '结论：优先使用 exFAT，但需要先确认设备和系统版本。',
    'Windows 和 macOS 原生支持读写，现代 Linux 内核通常也已原生支持；较旧发行版可能需要额外工具。',
    '与 NTFS、APFS、ext4 相比，它的跨平台兼容性最好，但缺少日志和完善权限模型，因此不能替代唯一备份盘。',
    '格式化前先备份，分区表选 GPT，并在三种系统各做一次大文件读写和安全弹出测试。',
    '如果还要连接电视、相机或游戏机，也要先查设备说明书是否支持 exFAT 和 GPT。',
  ].join('。')), false);

  const retryPrompt = buildSeriousReplyRetryPrompt('硬盘选什么文件系统', '建议 exFAT。');
  assert.match(retryPrompt, /重新独立核对事实/);
  assert.match(retryPrompt, /兼容性\/限制/);
});

test('攻击提示要求直接攻击，不强求逻辑关联或固定语料', () => {
  const prompt = buildAttackPrompt('你真是司马了', {
    attackScene: {
      id: 'test',
      hint: '测试用的单一截图画面',
    },
  });
  assert.match(prompt, /你真是司马了/);
  assert.match(prompt, /不需要讲逻辑/);
  assert.match(prompt, /本轮只使用这个随机画面种子：测试用的单一截图画面/);
  assert.match(prompt, /禁止孤立拉丁字母 ma/);
  assert.doesNotMatch(prompt, /公开龙图语料参考/);
});

test('有第三方目标时攻击提示不会默认攻击指令发送者', () => {
  const prompt = buildAttackPrompt('把他骂一顿', {
    interactionContext: {
      speakerLabel: '发令者（成员-aaaaaa）',
      targetLabels: ['目标成员（成员-bbbbbb）'],
      hasThirdPartyTarget: true,
    },
    attackScene: { id: 'test', hint: '测试画面' },
  });
  assert.match(prompt, /当前指令发送者：发令者/);
  assert.match(prompt, /本轮被攻击目标：目标成员/);
  assert.match(prompt, /不得把攻击落到指令发送者身上/);
  assert.equal(shouldUseAttackStyle('把他骂一顿', [], { hasThirdPartyTarget: true }), true);
});

test('攻击画面会排除近期已经用过的截图意象', () => {
  const selected = selectAttackScene([
    { role: 'assistant', content: '你🐎的骨灰盒上还刻着源码呢。' },
  ], { random: () => 0 });
  assert.notEqual(selected.id, 'urn-source');
});

test('自然龙图回复不需要拉丁字母 ma，并能检测错误拼接', () => {
  assert.equal(containsLiteralLatinMa('龙图往桌上一拍：你妈呢？'), false);
  assert.equal(containsLiteralLatinMa('龙图：ma 都笑了'), true);
  assert.equal(containsLiteralLatinMa('🐎 / ma / 妈'), true);
});

test('质量检查不强制说龙图，但拦截 ma、占位图和堆词', () => {
  const natural = reviewAttackReply('你🐎的骨灰盒上刻的源码，我照着抄的，咋了？');
  assert.equal(natural.valid, true);

  const literalMa = reviewAttackReply('你🐎的 ma 还在坟头笑呢。');
  assert.ok(literalMa.issues.includes('literal-ma'));

  const fakeImage = reviewAttackReply('你🐎都贴墙上了，自己看。[龙图.jpg]');
  assert.ok(fakeImage.issues.includes('fake-image-placeholder'));

  const piled = reviewAttackReply('你🐎喊老冯抱着族谱和户口本来看龙玉涛龙图。');
  assert.ok(piled.issues.includes('keyword-pile'));
});

test('质量检查拦截与近期回复高度重复的句式', () => {
  const reply = '你🐎的骨灰盒上刻的源码，我照着抄的，咋了？';
  const reviewed = reviewAttackReply(reply, {
    history: [{ role: 'assistant', content: reply }],
  });
  assert.ok(reviewed.issues.includes('repeated-style'));
});
