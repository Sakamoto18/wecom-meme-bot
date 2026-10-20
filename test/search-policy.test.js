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

test('互联网风格请求只改变输出口吻，不自动触发联网', () => {
  for (const content of ['这图接梗一下，来点抽象联想', '给个反差回复', '用互联网语气说']) {
    const styleOnly = classifySearchPolicy({ content });
    assert.equal(styleOnly.cultureEligible, false, content);
    assert.equal(styleOnly.factEligible, false, content);
  }
});

test('明确询问梗义或出处仍进入文化检索', () => {
  for (const content of ['这个网络梗是什么意思', '这个梗的来源是什么', '帮我查一下这句黑话怎么火的']) {
    const lookup = classifySearchPolicy({ content });
    assert.equal(lookup.cultureEligible, true, content);
    assert.equal(isHighConfidenceCulturePolicy(lookup), true, content);
  }
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
