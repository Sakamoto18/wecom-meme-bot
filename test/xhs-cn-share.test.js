import test from 'node:test';
import assert from 'node:assert/strict';
import { QqBotService } from '../src/qq-service.js';
import { ConversationStore } from '../src/conversation-store.js';

const url = 'https://xhslink.cn/o/6IV5SHvQTnX';

test('截图中的纯文本 .cn 分享和 QQ 卡片都进入小红书解析，不调用聊天模型', async () => {
  const calls = [];
  const service = new QqBotService({
    conversationStore: new ConversationStore(),
    webSearchEnabled: false,
    chatClient: { isConfigured: true, complete() { assert.fail('分享不应进入 LLM'); } },
    logger: { info() {}, warn() {} },
    mediaResolver: { enabled: true, async resolve(candidate) {
      calls.push(candidate);
      return { title: '原笔记标题', author: '原作者', coverUrl: 'https://cdn.example/cover.jpg',
        images: ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg'] };
    } },
  });
  for (const content of [{ text: url }, { text: '', rich_segments: [{ type: 'json', data: {
    data: JSON.stringify({ meta: { detail_1: { qqdocurl: url } } }),
  } }] }]) {
    const result = await service.handleMessage({ message_type: 'group', group_id: '1109147947',
      user_id: 'test', media_share: true, ...content });
    assert.equal(result.mode, 'media-gallery');
    assert.equal(result.messages[0].title, '原笔记标题');
  }
  assert.deepEqual(calls, [{ url, provider: 'xiaohongshu' }, { url, provider: 'xiaohongshu' }]);
});
