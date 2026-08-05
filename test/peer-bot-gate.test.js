import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerBotContinuationDecider } from '../src/peer-bot-gate.js';

function payload(overrides = {}) {
  return {
    messageType: 'group',
    groupId: 'g1',
    userId: 'peer-bot',
    senderName: '另一个机器人',
    text: '我还有一个具体问题',
    pureBotMention: false,
    ...overrides,
  };
}

test('peer Bot 首轮必回，后续纯艾特与客服套话直接静默', async () => {
  let calls = 0;
  const decider = new PeerBotContinuationDecider({
    chatClient: {
      isConfigured: true,
      async complete() {
        calls += 1;
        return 'continue';
      },
    },
  });

  assert.deepEqual(
    await decider.shouldContinue({ payload: payload(), replyCount: 0 }),
    { continue: true, reason: 'initial-peer-reply' },
  );
  assert.deepEqual(
    await decider.shouldContinue({
      payload: payload({ text: '@龙玉涛', pureBotMention: true }),
      replyCount: 1,
    }),
    { continue: false, reason: 'no-new-content' },
  );
  assert.deepEqual(
    await decider.shouldContinue({
      payload: payload({ text: '有什么需要我帮忙的吗？尽管说。' }),
      replyCount: 1,
    }),
    { continue: false, reason: 'generic-bot-filler' },
  );
  assert.equal(calls, 0);
});

test('peer Bot 后续是否回复由最近语境和当前新信息决定', async () => {
  const inputs = [];
  const outputs = ['continue', 'stop'];
  const decider = new PeerBotContinuationDecider({
    chatClient: {
      isConfigured: true,
      async complete(history, modelInput, options) {
        inputs.push({ history, modelInput, options });
        return outputs.shift();
      },
    },
  });
  const history = [
    { role: 'user', content: '对方先问了部署问题' },
    { role: 'assistant', content: '龙玉涛已经回答了第一部分' },
  ];

  const substantive = await decider.shouldContinue({
    payload: payload({ text: '新问题：另一个群 ID 要怎么处理？' }),
    currentContent: '新问题：另一个群 ID 要怎么处理？',
    history,
    replyCount: 1,
  });
  const repeated = await decider.shouldContinue({
    payload: payload({ text: '你说得对，我再接一句' }),
    history,
    replyCount: 2,
  });

  assert.deepEqual(substantive, { continue: true, reason: 'ai-continue' });
  assert.deepEqual(repeated, { continue: false, reason: 'ai-stop' });
  assert.equal(inputs.length, 2);
  assert.match(inputs[0].modelInput, /最近群聊/);
  assert.match(inputs[0].modelInput, /另一个群 ID/);
  assert.equal(inputs[0].options.temperature, 0);
  assert.deepEqual(inputs[0].options.thinking, { type: 'disabled' });
});

test('peer Bot 续聊判定故障或输出无效时默认静默', async () => {
  const warnings = [];
  const failing = new PeerBotContinuationDecider({
    chatClient: {
      isConfigured: true,
      async complete() {
        throw new Error('timeout');
      },
    },
    logger: { warn(message) { warnings.push(message); } },
  });
  const invalid = new PeerBotContinuationDecider({
    chatClient: {
      isConfigured: true,
      async complete() {
        return '我觉得可以继续';
      },
    },
  });

  assert.deepEqual(
    await failing.shouldContinue({ payload: payload(), replyCount: 1 }),
    { continue: false, reason: 'decision-error' },
  );
  assert.deepEqual(
    await invalid.shouldContinue({ payload: payload(), replyCount: 1 }),
    { continue: false, reason: 'invalid-output' },
  );
  assert.equal(warnings.length, 1);
});
