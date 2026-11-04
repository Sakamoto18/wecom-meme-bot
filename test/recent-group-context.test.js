import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRelevantReplyHistory } from '../src/recent-group-context.js';

test('相关性候选保留完整问答与图片摘要，选择后丢弃无关讨论', async () => {
  const relevant = [{ role: 'user', content: 'cobra的能源应用\n【当时图片摘要】眼镜蛇盘在电池柜上' },
    { role: 'assistant', content: '开柜前先请捕蛇的。' }];
  const result = await selectRelevantReplyHistory({ content: '电工打开会不会当场去世', histories: [
    [...relevant, { role: 'user', content: 'S8决赛八周年' }],
    [{ role: 'user', content: '今晚吃什么' }],
  ], chatClient: { isConfigured: true, async complete(_history, input) {
    const { candidates } = JSON.parse(input);
    assert.deepEqual(candidates[0].messages, relevant);
    return '{"ids":[0]}';
  } } });
  assert.deepEqual(result.history, relevant);
  assert.equal(result.candidates, 3);
});

test('独立新问题允许清空历史，模型不能编造候选ID', async () => {
  const options = { content: '明天天气如何', histories: [[{ role: 'user', content: '电池柜有蛇' }]] };
  assert.deepEqual((await selectRelevantReplyHistory({ ...options, chatClient: { isConfigured: true, complete: async () => '{"ids":[]}' } })).history, []);
  await assert.rejects(selectRelevantReplyHistory({ ...options, chatClient: { isConfigured: true, complete: async () => '{"ids":[999]}' } }), /Invalid context/);
});
