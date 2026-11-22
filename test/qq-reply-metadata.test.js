import test from 'node:test';
import assert from 'node:assert/strict';
import { QqBotService } from '../src/qq-service.js';
import { ConversationStore } from '../src/conversation-store.js';

function createService(options) {
  return { service: new QqBotService({
    conversationStore: new ConversationStore(), webSearchEnabled: false,
    imageOcrEnabled: false, logger: { log() {}, warn() {}, info() {} }, ...options,
  }) };
}

for (const group of ['913546080', 'qqofficial:1903660238:group:F715FFD286FB70F451417AD2F5519256']) {
  test(`游戏知识回答在存储和拆分前去除内部身份标签：${group}`, async () => {
    const answer = '听清了，具体进化条件还得核对，不能把其他精灵的流程直接套过来。';
    const envelope = [
      '【机器人群聊回复记录】',
      '本轮回复对象：至高无上的真龙王（成员-ede6ee）',
      '本轮回复对象QQ号（仅供历史消歧）：1079175957',
      `机器人回复：${answer}`,
    ].join('\n');
    const ownReplies = [];
    const { service } = createService({
      memeStore: { async pick() { return null; } },
      groupMemory: { recordOwnReply(row) { ownReplies.push(row.text); } },
      chatClient: { isConfigured: true, async complete(_history, _input, options) {
        if (options.usageSource === 'roco-grounding-review') return '{"supported":true}';
        return envelope;
      } },
    });
    service.rocoKnowledge = {
      retrieve: async () => ({ records: [], metadata: { importedAt: '2026-11-22' } }),
      remember() {},
    };
    const result = await service.handleMessage({
      message_id: `game-envelope-${group}`, message_type: 'group', group_id: group,
      user_id: '1079175957', nickname: '至高无上的真龙王', bot_user_id: 'bot',
      mentions: [{ user_id: 'bot' }], text: '我问的是怎么进化，要不要投喂首领药？',
    });
    assert.equal(result.mode, 'game-knowledge');
    assert.deepEqual(result.messages, [{ type: 'text', text: answer }]);
    assert.deepEqual(ownReplies, [answer]);
    const stored = service.conversationStore.get(`group:${group}`).findLast(row => row.role === 'assistant').content;
    assert.equal(stored.split('【机器人群聊回复记录】').length - 1, 1);
    assert.equal(stored.split('机器人回复：')[1], answer);
    assert.equal(stored.split('仅供历史消歧').length - 1, 1);
  });
}

test('游戏回答清除内部记录后为空时不发送标签或空消息', async () => {
  const { service } = createService({
    memeStore: { async pick() { return null; } },
    chatClient: { isConfigured: true, async complete(_history, _input, options) {
      if (options.usageSource === 'roco-grounding-review') return '{"supported":true}';
      return '【机器人群聊回复记录】\n本轮回复对象：群友\n本轮回复对象QQ号（仅供历史消歧）：1079175957\n机器人回复：';
    } },
  });
  service.rocoKnowledge = {
    retrieve: async () => ({ records: [], metadata: { importedAt: '2026-11-22' } }), remember() {},
  };
  const result = await service.handleMessage({ message_type: 'private', user_id: 'user', text: '阿布怎么进化' });
  assert.equal(result.mode, 'game-knowledge');
  assert.deepEqual(result.messages, [{ type: 'text', text: '这条暂时没答好，你再问一句。' }]);
});

