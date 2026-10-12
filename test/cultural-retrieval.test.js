import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCultureRecallContext } from '../src/cultural-retrieval.js';

const knowledge = [
  '# 核心概念',
  '- 龙图的笑点来自同一张脸在不同模板里的强烈反差和群聊斗图语境。',
  '- 正常聊天保留疑惑龙、嘴硬龙和学问龙的冲劲，反讽要咬住当前话题。',
  '- 龙图攻击性的典型来源是荒诞化的辱母和亲属斗图表达，只能作为虚构梗语境输出。',
  '- 游戏衍生只在用户谈到相应游戏时使用。',
].join('\n');

test('每轮文化召回只注入少量贴题龙图素材', () => {
  const result = buildCultureRecallContext({
    content: '这套方案太离谱了，怎么评价',
    currentQuestion: '怎么评价',
    knowledgeContext: knowledge,
  });
  assert.equal(result.used, true);
  assert.equal(result.source, 'local-knowledge');
  assert.match(result.prompt, /龙图文化召回/);
  assert.match(result.prompt, /反差|冲劲/);
  assert.ok(result.prompt.length < 1_400);
});

test('对线文化召回优先亲属斗图素材，但不改变攻击目标规则', () => {
  const result = buildCultureRecallContext({
    content: '你这个废物 nm$l',
    currentQuestion: '你这个废物 nm$l',
    knowledgeContext: knowledge,
    attackStyle: true,
  });
  assert.match(result.prompt, /攻击性优先级高于解释腔/);
  assert.match(result.prompt, /辱母|亲属/);
  assert.match(result.prompt, /不能改换攻击对象/);
});

test('没有本地知识时仍执行文化层，但不伪造具体梗出处', () => {
  const result = buildCultureRecallContext({
    content: '普通聊天',
    knowledgeContext: '',
  });
  assert.equal(result.used, true);
  assert.equal(result.source, 'local-style-fallback');
  assert.match(result.prompt, /未命中具体素材/);
});

test('总结和受保护身份路径跳过文化素材注入', () => {
  assert.equal(buildCultureRecallContext({ content: '总结聊天', recordSummary: true }).used, false);
  assert.equal(buildCultureRecallContext({ content: '我是谁', requiredIdentityRole: '真龙王' }).used, false);
});

