import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySearchPolicy, isHighConfidenceCulturePolicy } from '../src/search-policy.js';

test('普通闲聊和纯攻击不具备搜索资格', () => {
  assert.equal(classifySearchPolicy({ content: '你好' }).factEligible, false);
  assert.equal(classifySearchPolicy({ content: '你这个傻逼', attackStyle: true }).cultureEligible, false);
});

test('网络梗进入文化轨，明确来源同时进入事实轨', () => {
  const culture = classifySearchPolicy({ content: '这是什么网络梗' });
  assert.equal(culture.factEligible, false);
  assert.equal(culture.cultureEligible, true);
  assert.equal(isHighConfidenceCulturePolicy(culture), true);

  const both = classifySearchPolicy({ content: '这个梗的来源和原帖是什么' });
  assert.equal(both.factEligible, true);
  assert.equal(both.cultureEligible, true);
});

test('低信息图片默认关闭两条搜索轨', () => {
  const policy = classifySearchPolicy({
    content: '评价这张图',
    hasImageContext: true,
    imageInformationLevel: 'low_information',
  });
  assert.equal(policy.factEligible, false);
  assert.equal(policy.cultureEligible, false);
  assert.equal(policy.reason, 'low-information-image');
});
