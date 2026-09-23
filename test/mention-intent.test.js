import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMentionIntent, shouldCheckMentionIntent } from '../src/mention-intent.js';

test('只把真人直接艾特中的短歧义文本交给语义判断，不按内容直接判攻击', () => {
  for (const text of ['看看奶子', '在？', '那五口的呢', '帮忙不了，算了']) {
    assert.equal(shouldCheckMentionIntent(text, { directBotMention: true }), true, text);
    assert.equal(shouldCheckMentionIntent(text), false, text);
  }
  for (const flag of ['hasImageContext', 'hasQuotedContent', 'hasVideoContext', 'recordSummary', 'hasThirdPartyTarget', 'attackStyle', 'requiredIdentityRole']) {
    assert.equal(shouldCheckMentionIntent('看看', { directBotMention: true, [flag]: true }), false, flag);
  }
});

test('明确问题、联网请求、危机求助和链接不进入无意义艾特检查', () => {
  for (const text of ['为什么失败', '怎么配置', '多少钱', '这是什么梗', '今天北京天气', '联网查一下最新消息', '我不想活了', '我妈去世了', 'https://b23.tv/abc', '/persona']) {
    assert.equal(shouldCheckMentionIntent(text, { directBotMention: true }), false, text);
  }
});

test('语义检查只接受有限长度的 banter 字段，其他输出交回正常链路', () => {
  assert.equal(parseMentionIntent('{"kind":"banter","reply":"闲得你，艾特键让你当门铃按了。"}'), '闲得你，艾特键让你当门铃按了。');
  assert.equal(parseMentionIntent('```json\n{"kind":"banter","reply":"有屁就放，搁这试门铃呢。"}\n```'), '有屁就放，搁这试门铃呢。');
  for (const value of ['不确定', '{"kind":"continue"}', '{"kind":"banter"}', '{"kind":"banter","reply":12}', '{"kind":"banter","reply":""}', JSON.stringify({kind:'banter',reply:'很长'.repeat(40)}), JSON.stringify({kind:'banter',reply:'第一条\n第二条'})]) {
    assert.equal(parseMentionIntent(value), null, value);
  }
});
