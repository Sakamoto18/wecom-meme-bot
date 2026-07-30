import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelInput,
  extractMessageText,
  getConversationId,
  getAnonymousSpeakerId,
  getMessageTarget,
  hasImageContent,
} from '../src/message-utils.js';

test('提取文本、语音和图文混排中的文字', () => {
  assert.equal(extractMessageText({
    msgtype: 'text',
    text: { content: '@机器人 你好' },
  }), '你好');
  assert.equal(extractMessageText({
    msgtype: 'voice',
    voice: { content: '来张龙图' },
  }), '来张龙图');
  assert.equal(extractMessageText({
    msgtype: 'mixed',
    mixed: {
      msg_item: [
        { msgtype: 'text', text: { content: '@机器人 第一句' } },
        { msgtype: 'image', image: { url: 'ignored' } },
        { msgtype: 'text', text: { content: '第二句' } },
      ],
    },
  }), '第一句\n第二句');
});

test('引用消息会一起传给模型', () => {
  const message = {
    quote: { msgtype: 'text', text: { content: '被引用内容' } },
  };
  assert.equal(
    buildModelInput(message, '当前内容'),
    '引用消息：被引用内容\n当前消息：当前内容',
  );
});

test('同一群聊共享会话，不同群和私聊继续隔离', () => {
  assert.equal(getConversationId({
    chattype: 'group',
    chatid: 'group-1',
    from: { userid: 'user-1' },
  }), 'group:group-1');
  assert.equal(getConversationId({
    chattype: 'group',
    chatid: 'group-1',
    from: { userid: 'user-2' },
  }), 'group:group-1');
  assert.equal(getConversationId({
    chattype: 'group',
    chatid: 'group-2',
    from: { userid: 'user-1' },
  }), 'group:group-2');
  assert.equal(getConversationId({
    chattype: 'single',
    from: { userid: 'user-1' },
  }), 'single:user-1');
});

test('群聊模型输入包含匿名且稳定的发言人标签', () => {
  const first = buildModelInput({
    chattype: 'group',
    from: { userid: 'sensitive-user-id' },
  }, '当前内容');
  const second = buildModelInput({
    chattype: 'group',
    from: { userid: 'sensitive-user-id' },
  }, '下一句');

  const firstLabel = first.split('\n')[0];
  const secondLabel = second.split('\n')[0];
  assert.match(first, /^发言人：群成员-[a-f0-9]{6}\n当前消息：当前内容$/);
  assert.equal(firstLabel, secondLabel);
  assert.doesNotMatch(first, /sensitive-user-id/);
});

test('人工标注的群成员使用昵称，未标注成员继续匿名', () => {
  const message = {
    chattype: 'group',
    from: { userid: 'known-user-id' },
  };
  const speakerId = getAnonymousSpeakerId(message);
  assert.equal(
    buildModelInput(message, '当前内容', { [speakerId]: '玉涛龙大王' }),
    '发言人：玉涛龙大王\n当前消息：当前内容',
  );
  assert.match(
    buildModelInput({ chattype: 'group', from: { userid: 'unknown-user-id' } }, '你好'),
    /^发言人：群成员-[a-f0-9]{6}\n当前消息：你好$/,
  );
});

test('主动附图为单聊和群聊选择正确目标', () => {
  assert.equal(getMessageTarget({
    chattype: 'single',
    from: { userid: 'user-1' },
  }), 'user-1');
  assert.equal(getMessageTarget({
    chattype: 'group',
    chatid: 'group-1',
    from: { userid: 'user-1' },
  }), 'group-1');
  assert.equal(getMessageTarget({ chattype: 'group' }), '');
});

test('识别单图和图文混排中的图片', () => {
  assert.equal(hasImageContent({ msgtype: 'image', image: {} }), true);
  assert.equal(hasImageContent({
    msgtype: 'mixed',
    mixed: { msg_item: [{ msgtype: 'text' }, { msgtype: 'image' }] },
  }), true);
  assert.equal(hasImageContent({ msgtype: 'text', text: {} }), false);
});
