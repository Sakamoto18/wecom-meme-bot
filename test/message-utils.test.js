import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelInput,
  extractMessageText,
  getConversationId,
  getAnonymousSpeakerId,
  getMessageTarget,
  getGroupInteractionContext,
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
  assert.match(first, /^当前发言人：群成员-[a-f0-9]{6}\n【身份归属硬边界】[\s\S]+\n当前消息：当前内容$/);
  assert.equal(firstLabel, secondLabel);
  assert.doesNotMatch(first, /sensitive-user-id/);
});

test('人工标注的群成员使用昵称，未标注成员继续匿名', () => {
  const message = {
    chattype: 'group',
    from: { userid: 'known-user-id' },
  };
  const speakerId = getAnonymousSpeakerId(message);
  assert.match(
    buildModelInput(message, '当前内容', { [speakerId]: '玉涛龙大王' }),
    new RegExp(`^当前发言人：玉涛龙大王（成员-${speakerId}）\\n【身份归属硬边界】[\\s\\S]+\\n当前消息：当前内容$`),
  );
  assert.match(
    buildModelInput({ chattype: 'group', from: { userid: 'unknown-user-id' } }, '你好'),
    /^当前发言人：群成员-[a-f0-9]{6}\n【身份归属硬边界】[\s\S]+\n当前消息：你好$/,
  );
});

test('群聊当前消息与引用消息的主语和账户归属明确隔离', () => {
  const input = buildModelInput({
    chattype: 'group',
    from: { userid: 'sender', name: '发言者' },
    bot_user_id: 'bot',
    mentions: [{ user_id: 'bot', name: '龙玉涛' }],
    quote: {
      msgtype: 'text',
      text: { content: '我的账户还有 82 万' },
      from: { userid: 'bot', name: '龙玉涛' },
    },
  }, '我给不了你完整的一生，这是你的账户，你能自己去赚 82 万吗');

  assert.match(input, /当前消息中的“我\/我们”默认属于当前发言人/);
  assert.match(input, /“你\/你的”默认指机器人/);
  assert.match(input, /引用消息是单独的第三方原话/);
  assert.match(input, /引用消息作者是机器人；引用中的“我\/我的”属于机器人/);
  assert.match(input, /当前消息：我给不了你完整的一生/);
});

test('群聊输入区分指令发送者、被 @ 成员和引用作者', () => {
  const input = buildModelInput({
    chattype: 'group',
    from: { userid: 'sender', name: '发令者' },
    bot_user_id: 'bot',
    mentions: [
      { user_id: 'bot', name: '机器人' },
      { user_id: 'target', name: '被点名者' },
    ],
    quote: {
      msgtype: 'text',
      text: { content: '被引用的话' },
      from: { userid: 'quoted', name: '引用作者' },
    },
  }, '骂他');

  assert.match(input, /当前发言人：发令者（成员-[a-f0-9]{6}）/);
  assert.match(input, /本条消息指向或提到的群成员：被点名者（成员-[a-f0-9]{6}）、引用作者（成员-[a-f0-9]{6}）/);
  assert.match(input, /引用消息作者：引用作者（成员-[a-f0-9]{6}）/);
  assert.match(input, /引用消息内容：被引用的话/);
  assert.doesNotMatch(input, /机器人（成员-/);
});

test('只有引用作者时也会把引用作者作为第三方目标', () => {
  const input = buildModelInput({
    chattype: 'group',
    from: { userid: 'sender', name: '提问者' },
    bot_user_id: 'bot',
    mentions: [{ user_id: 'bot', name: '机器人' }],
    quote: {
      msgtype: 'text',
      text: { content: '被引用的一句话' },
      from: { userid: 'quoted', name: '引用作者' },
    },
  }, '评价一下');

  assert.match(input, /本条消息指向或提到的群成员：引用作者/);
  assert.match(input, /引用消息作者：引用作者/);
  assert.match(input, /引用消息内容：被引用的一句话/);
  assert.doesNotMatch(input, /提问者（成员-[a-f0-9]{6}）.*引用消息作者：提问者/);
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

test('真实 @机器人会确认收件关系，不能被第三方目标过滤误伤', () => {
  const message = {
    msgtype: 'text',
    chattype: 'group',
    from: { userid: 'sender', name: '发言者' },
    bot_user_id: 'bot',
    bot_names: ['龙玉涛'],
    mentions: [
      { user_id: 'bot', name: '龙玉涛' },
      { user_id: 'target', name: '被点名者' },
    ],
    text: { content: '@龙玉涛 你怎么看' },
  };
  const interaction = getGroupInteractionContext(message);
  assert.equal(interaction.addressedBotByName, true);
  assert.equal(interaction.addressedBotName, '龙玉涛');
  assert.equal(interaction.hasThirdPartyTarget, true);
  assert.match(buildModelInput(message, '你怎么看'), /正在称呼机器人“龙玉涛”/);
  assert.match(buildModelInput(message, '你怎么看'), /被点名者/);
});

test('真实 @带后缀昵称时仍以 QQ ID 认定机器人，并把群号交给模型消歧', () => {
  const message = {
    msgtype: 'text',
    chattype: 'group',
    chatid: '766304475',
    from: { userid: 'sender', name: '发言者' },
    bot_user_id: '2170902293',
    bot_names: ['龙玉涛'],
    mentions: [{ user_id: '2170902293', name: '龙玉涛bot-deepseek大肥鱼版' }],
    text: { content: '@龙玉涛bot-deepseek大肥鱼版 还能说话吗' },
  };
  const interaction = getGroupInteractionContext(message);
  assert.equal(interaction.explicitBotMention, true);
  assert.equal(interaction.botUserId, '2170902293');
  assert.equal(interaction.groupId, '766304475');
  assert.equal(interaction.addressedBotName, '龙玉涛bot-deepseek大肥鱼版');
  const input = buildModelInput(message, '还能说话吗');
  assert.match(input, /当前群号=766304475；机器人 QQ 号=2170902293/u);
  assert.match(input, /完整显示名“龙玉涛bot-deepseek大肥鱼版”只是机器人当前昵称/u);
  assert.match(input, /不是第三方成员、现实身份或事实标签/u);
});

test('临时外号只作为不可信候选，不写进固定机器人别名', () => {
  const message = {
    msgtype: 'text',
    chattype: 'group',
    from: { userid: 'sender' },
    bot_user_id: 'bot',
    bot_names: ['龙玉涛'],
    text: { content: '再见了龙小弟' },
  };
  const interaction = getGroupInteractionContext(message);
  assert.equal(interaction.addressedBotByName, false);
  assert.equal(interaction.addressedBotName, '');
  assert.equal(interaction.botAddressCandidate, '龙小弟');
  assert.equal(interaction.botAddressCandidateIsUntrusted, true);
  assert.equal(interaction.botAddressCandidateSpeechAct, 'farewell');
  const input = buildModelInput(message, '再见了龙小弟');
  assert.match(input, /可能的称呼“龙小弟”/);
  assert.match(input, /不要把临时称呼写入固定别名/);
  assert.doesNotMatch(input, /正在称呼机器人“龙小弟”/);
});

test('纠正句保留为语用候选，交给上下文判断而不是写死外号', () => {
  const message = {
    msgtype: 'text',
    chattype: 'group',
    from: { userid: 'sender' },
    bot_user_id: 'bot',
    bot_names: ['龙玉涛'],
    text: { content: '我是说你要跟我们说再见了' },
  };
  const interaction = getGroupInteractionContext(message);
  assert.equal(interaction.isCorrectionOfPreviousReply, false);
  assert.equal(interaction.correctionCandidate, true);
  assert.match(buildModelInput(message, message.text.content), /可能在纠正上一轮回复/);
});

test('不对和我问的是会被识别为纠正上一轮回答', () => {
  for (const content of ['不对，我问的是端口怎么配', '错了，重点是群里那条新问题']) {
    const message = {
      msgtype: 'text',
      chattype: 'group',
      from: { userid: 'sender' },
      bot_user_id: 'bot',
      text: { content },
    };
    const interaction = getGroupInteractionContext(message);
    assert.equal(interaction.correctionCandidate, true);
    assert.match(buildModelInput(message, content), /可能在纠正上一轮回复/);
  }
});

test('真实 @ 只确认对象，不能把对比或互损判成机器人听错', () => {
  for (const content of ['我扣问号不是我有问题，是我觉得你有问题', '不是我不想下班，是这会还没开完。', '不对，我问的是端口怎么配']) {
    const message = { msgtype: 'text', chattype: 'group', from: { userid: 'sender' },
      bot_user_id: 'bot', bot_names: ['龙2号机'], mentions: [{ user_id: 'bot', name: '龙2号机' }],
      text: { content } };
    const interaction = getGroupInteractionContext(message);
    assert.equal(interaction.explicitBotMention, true);
    assert.equal(interaction.addressedBotByName, true);
    assert.equal(interaction.isCorrectionOfPreviousReply, false);
    assert.equal(interaction.correctionCandidate, true);
    const input = buildModelInput(message, content);
    assert.match(input, /可能在纠正/);
    assert.match(input, /不要求先认错或自证/);
    assert.doesNotMatch(input, /先承认指代或意图判断错/);
    assert.ok(input.endsWith(`当前消息：${content}`));
  }
});
