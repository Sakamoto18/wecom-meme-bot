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

test('重复歌词样式即使没有“梗”二字也进入来源文化检索', () => {
  const policy = classifySearchPolicy({ content: '九妹九妹，上路的堡垒' });
  assert.equal(policy.cultureEligible, true);
  assert.equal(policy.lyricMemeTemplate, true);
  assert.equal(policy.factEligible, false);
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

test('有图片语义场景线索时低信息图开启文化检索，不误开事实检索', () => {
  const policy = classifySearchPolicy({
    content: '笑点解析',
    hasImageContext: true,
    imageSearch: true,
    imageInformationLevel: 'low_information',
    semanticImageSearch: true,
  });
  assert.equal(policy.factEligible, false);
  assert.equal(policy.cultureEligible, true);
});

test('Jev 的事实与时效信号不依赖正则也能开启事实检索', () => {
  const fact = classifySearchPolicy({ content: '这个说法对吗', factLookupNeeded: 0.8 });
  assert.equal(fact.factEligible, true);
  assert.equal(fact.reason, 'fact-intent');

  const fresh = classifySearchPolicy({ content: '现在是什么情况', timeSensitive: 0.7 });
  assert.equal(fresh.factEligible, true);

  const unknown = classifySearchPolicy({ content: '这个说法对吗', unknownConcept: true });
  assert.equal(unknown.factEligible, true);
});

test('Jev 文化信号达到放宽阈值即可进入文化轨', () => {
  const culture = classifySearchPolicy({ content: '接一下这个', cultureLookupNeeded: 0.42 });
  assert.equal(culture.cultureEligible, true);
});

test('攻击轮只保留事实轨，文化轨仍关闭', () => {
  const policy = classifySearchPolicy({
    content: '你这个傻逼，一加一等于几',
    attackStyle: true,
    factLookupNeeded: 0.8,
  });
  assert.equal(policy.factEligible, true);
  assert.equal(policy.cultureEligible, false);
  assert.equal(policy.reason, 'attack-turn-fact-only');
});

test('低信息图只有明确求证或来源问题才打开事实轨', () => {
  const logo = classifySearchPolicy({
    content: '这是谁家的logo',
    hasImageContext: true,
    imageSearch: true,
    imageInformationLevel: 'low_information',
  });
  assert.equal(logo.factEligible, true);
  assert.equal(logo.reason, 'explicit-low-information-image');
  assert.equal(logo.verificationRequested, true);

  const real = classifySearchPolicy({
    content: '真的假的',
    hasImageContext: true,
    imageSearch: true,
    imageInformationLevel: 'low_information',
  });
  assert.equal(real.factEligible, true);
  assert.equal(real.verificationRequested, true);

  const evaluate = classifySearchPolicy({
    content: '评价一下',
    hasImageContext: true,
    imageInformationLevel: 'low_information',
  });
  assert.equal(evaluate.factEligible, false);
  assert.equal(evaluate.reason, 'low-information-image');
});

test('相对天数追问即使承接低信息图片也必须打开事实检索', () => {
  const policy = classifySearchPolicy({
    content: '9天后有什么事情',
    imageSearch: true,
    hasImageContext: true,
    imageInformationLevel: 'low_information',
  });
  assert.equal(policy.factEligible, true);
  assert.equal(policy.verificationRequested, true);
  assert.equal(policy.reason, 'explicit-low-information-image');
});

test('带日期或有现实锚点的群聊梗必须打开事实检索', () => {
  const php = classifySearchPolicy({
    content: '昨天的php漏洞是个什么情况没看懂什么意思',
  });
  assert.equal(php.textFactEligible, true);
  assert.equal(php.factEligible, true);
  assert.equal(php.cultureEligible, false);

  const linked = classifySearchPolicy({
    content: '这个漏洞和图中的梗有什么关系',
  });
  assert.equal(linked.textFactEligible, true);
  assert.equal(linked.factEligible, true);

  const privateKey = classifySearchPolicy({
    content: '不是，你不能解释一下为什么这个4就是完整密钥了啊？？？',
  });
  assert.equal(privateKey.textFactEligible, true);
  assert.equal(privateKey.factEligible, true);
});

test('普通时间词和普通数字不会单独触发事实检索', () => {
  for (const content of ['昨天的晚饭真好吃', '我今天打了四把游戏', '这图挺有意思']) {
    const policy = classifySearchPolicy({ content });
    assert.equal(policy.textFactEligible, false, content);
    assert.equal(policy.factEligible, false, content);
  }
});

test('技术主体加近期时间也会打开事实检索，即使没说漏洞二字', () => {
  const php = classifySearchPolicy({
    content: '不是最近php的事情你不知道吗？影响最大的是日本it你不知道吗',
  });
  assert.equal(php.textFactEligible, true);
  assert.equal(php.recentEventRequested, true);
  assert.equal(php.factEligible, true);

  const ordinary = classifySearchPolicy({ content: '最近我在学 PHP' });
  assert.equal(ordinary.factEligible, false);
});

test('低信息截图承接明确文字锚点时仍允许事实检索', () => {
  const php = classifySearchPolicy({
    content: '昨天的php漏洞是个什么情况没看懂什么意思',
    imageSearch: true,
    hasImageContext: true,
    imageInformationLevel: 'low_information',
  });
  assert.equal(php.factEligible, true);
  assert.equal(php.reason, 'concrete-text-fact');

  const key = classifySearchPolicy({
    content: '为什么这个4就是完整密钥',
    imageSearch: true,
    hasImageContext: true,
    imageInformationLevel: 'low_information',
  });
  assert.equal(key.factEligible, true);

  const generic = classifySearchPolicy({
    content: '这张图怎么回事',
    imageSearch: true,
    hasImageContext: true,
    imageInformationLevel: 'low_information',
  });
  assert.equal(generic.factEligible, false);
  assert.equal(generic.reason, 'low-information-image');
});
