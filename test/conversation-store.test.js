import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationStore } from '../src/conversation-store.js';

test('会话记忆受消息条数限制且不同会话隔离', () => {
  const store = new ConversationStore({ maxMessages: 4 });
  store.appendExchange('user-a', '问1', '答1');
  store.appendExchange('user-a', '问2', '答2');
  store.appendExchange('user-a', '问3', '答3');
  store.appendExchange('user-b', '另一问', '另一答');

  assert.deepEqual(store.get('user-a').map((message) => message.content), [
    '问2', '答2', '问3', '答3',
  ]);
  assert.deepEqual(store.get('user-b').map((message) => message.content), [
    '另一问', '另一答',
  ]);
});

test('会话记忆受总字符数硬限制', () => {
  const store = new ConversationStore({
    maxMessages: 20,
    maxCharacters: 1_000,
  });
  for (let index = 0; index < 8; index += 1) {
    store.appendExchange('group:one', '问'.repeat(120), '答'.repeat(120));
  }
  const characters = store.get('group:one')
    .reduce((total, message) => total + message.content.length, 0);
  assert.ok(characters <= 1_000);
});

test('超过最大会话数时淘汰最久未更新的会话', () => {
  let now = 1_000;
  const store = new ConversationStore({
    maxConversations: 2,
    now: () => now,
  });
  store.appendExchange('group:a', '问', '答');
  now += 1;
  store.appendExchange('group:b', '问', '答');
  now += 1;
  store.appendExchange('group:c', '问', '答');

  assert.deepEqual(store.get('group:a'), []);
  assert.equal(store.size, 2);
});

test('同一会话的并发任务会按顺序执行', async () => {
  const store = new ConversationStore();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = store.runExclusive('same-user', async () => {
    events.push('first-start');
    await firstGate;
    events.push('first-end');
  });
  const second = store.runExclusive('same-user', async () => {
    events.push('second');
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second']);
});

test('受限会话记忆可落盘并在新进程实例中恢复', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wecom-memory-test-'));
  const filePath = path.join(directory, 'conversation-memory.json');

  try {
    const first = new ConversationStore({
      filePath,
      maxMessages: 6,
      maxCharacters: 1_000,
      ttlMs: 60_000,
    });
    first.appendExchange('group:group-1', '成员甲：上一问', '上一答');
    await first.flush();

    const second = new ConversationStore({
      filePath,
      maxMessages: 6,
      maxCharacters: 1_000,
      ttlMs: 60_000,
    });
    assert.equal(await second.load(), 1);
    assert.deepEqual(
      second.get('group:group-1').map((message) => message.content),
      ['成员甲：上一问', '上一答'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
