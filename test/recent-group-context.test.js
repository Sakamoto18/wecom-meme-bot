import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRelevantReplyHistory, selectReplyImages, normalizeRecentGroupContext } from '../src/recent-group-context.js';

const imageContext = () => ({ messages: [
  { messageId: 'a', userId: 'asker', senderName: '小甲', text: '[图片]' },
  { messageId: 'b', userId: 'other', senderName: '小乙', text: '[图片]' },
], images: [{ messageId: 'a', base64: 'iVBORaW1hZ2U=' }, { messageId: 'b', base64: '/9jaW1hZ2U=' }] });

test('所有历史图片均须语义选择，空结果和失败不强塞本人图', async () => {
  for (const size of [1, 2]) {
    const context = imageContext();
    context.messages = context.messages.slice(0, size); context.images = context.images.slice(0, size);
    for (const [output, expected] of [['{"ids":[0]}', ['a']], ['{"ids":[]}', []], ['invalid', []], ['{"ids":[99]}', []]]) {
      let calls = 0;
      const selected = await selectReplyImages({ context, speakerUserId: 'asker', content: '前面路口怎么走',
        chatClient: { isConfigured: true, async complete(_h, input, options) {
          calls++;
          assert.equal(options.usageSource, 'reply-image-relevance');
          assert.equal(input.filter(b => b.type === 'image_url').length, size);
          assert.match(input[2].image_url.url, /^data:image\/png/);
          assert.equal(JSON.parse(input[0].text).question, '前面路口怎么走');
          return output;
        } } });
      assert.deepEqual(selected.map(i => i.messageId), expected); assert.equal(calls, 1);
    }
    assert.deepEqual(await selectReplyImages({ context, speakerUserId: 'asker', content: '小乙的图怎么看' }), []);
    assert.deepEqual(await selectReplyImages({ context, speakerUserId: 'asker', content: '这张图',
      chatClient: { isConfigured: true, complete: async () => { throw new Error('timeout'); } } }), []);
  }
  for (const [question, output, expected] of [
    ['两个放一起比较', [0, 1], ['a', 'b']],
    ['右边那位发的呢', [1], ['b']],
    ['这个配色太艳了吗', [0], ['a']],
  ]) {
    const selected = await selectReplyImages({ context: imageContext(), speakerUserId: 'asker', content: question,
      chatClient: { isConfigured: true, complete: async () => JSON.stringify({ ids: output }) } });
    assert.deepEqual(selected.map(i => i.messageId), expected);
  }
});

test('多源图按来源校验，保留每人两张；陌生图片不得混入', () => {
  const raw = { group_id: 'g', messages: [{ message_id: 'a', user_id: 'asker', text: '[图片]' },
    { message_id: 'b', user_id: 'other', text: '[图片]' }], images: ['a', 'a', 'b', 'b', 'unknown']
    .map(message_id => ({ message_id, base64: 'aW1hZ2U=' })) };
  assert.equal(normalizeRecentGroupContext(raw, { groupId: 'g' }).images.length, 4);
});

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
