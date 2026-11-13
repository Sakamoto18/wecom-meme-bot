import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRelevantReplyHistory, selectReplyImages, normalizeRecentGroupContext } from '../src/recent-group-context.js';

const imageContext = () => ({ messages: [
  { messageId: 'a', userId: 'asker', senderName: '小甲', text: '[图片]' },
  { messageId: 'b', userId: 'other', senderName: '小乙', text: '[图片]' },
], images: [{ messageId: 'a', base64: 'iVBORaW1hZ2U=' }, { messageId: 'b', base64: '/9jaW1hZ2U=' }] });

test('多人插图：模糊追问保留本人图；其他图须经过关联选择', async () => {
  const context = imageContext();
  for (const output of ['{"ids":[0]}', 'invalid', '{"ids":[99]}']) {
    const selected = await selectReplyImages({ context, speakerUserId: 'asker', content: '这张图怎么看',
      chatClient: { isConfigured: true, async complete(_h, input, options) {
        assert.equal(options.usageSource, 'reply-image-relevance');
        assert.equal(input.filter(b => b.type === 'image_url').length, 2);
        assert.match(input[2].image_url.url, /^data:image\/png/);
        return output;
      } } });
    assert.deepEqual(selected.map(i => i.messageId), ['a']);
  }
  const related = await selectReplyImages({ context, speakerUserId: 'asker', content: '这两张图放一起怎么看',
    chatClient: { isConfigured: true, complete: async () => '{"ids":[1,0]}' } });
  assert.deepEqual(related.map(i => i.messageId), ['a', 'b']);
  const named = await selectReplyImages({ context, speakerUserId: 'asker', content: '小乙的图怎么看' });
  assert.deepEqual(named.map(i => i.messageId), ['b']);
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
