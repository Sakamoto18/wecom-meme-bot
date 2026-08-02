import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { QqMemoryStore } from '../src/qq-memory-store.js';

async function withTemporaryDirectory(task) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qq-memory-test-'));
  try {
    await task(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('SQLite QQ 记忆会自动建目录并在重新打开后恢复', async () => {
  await withTemporaryDirectory(async (directory) => {
    const databaseFilePath = path.join(directory, 'nested', 'qq-memory.sqlite');
    const first = new QqMemoryStore({ databaseFilePath, ttlMs: 60_000 });
    assert.equal(await first.load(), 0);
    first.appendExchange('private:u1', '上一问', '上一答');
    first.close();

    const second = new QqMemoryStore({ databaseFilePath, ttlMs: 60_000 });
    assert.equal(await second.load(), 1);
    assert.deepEqual(second.get('private:u1'), [
      { role: 'user', content: '上一问' },
      { role: 'assistant', content: '上一答' },
    ]);
    second.close();
  });
});
test('旧 QQ JSON 记忆只自动迁移一次且跳过过期会话', async () => {
  await withTemporaryDirectory(async (directory) => {
    const now = 10_000;
    const legacyFilePath = path.join(directory, 'qq-conversation-memory.json');
    const databaseFilePath = path.join(directory, 'qq-memory.sqlite');
    await writeFile(legacyFilePath, JSON.stringify({
      version: 1,
      conversations: {
        'group:active': {
          messages: [
            { role: 'user', content: '迁移问题' },
            { role: 'assistant', content: '迁移回答' },
          ],
          updatedAt: now - 10,
          expiresAt: now + 60_000,
        },
        'group:expired': {
          messages: [
            { role: 'user', content: '过期问题' },
            { role: 'assistant', content: '过期回答' },
          ],
          updatedAt: now - 100,
          expiresAt: now - 1,
        },
      },
    }), 'utf8');

    const first = new QqMemoryStore({
      databaseFilePath,
      legacyFilePath,
      now: () => now,
    });
    assert.equal(await first.load(), 1);
    assert.deepEqual(first.get('group:active').map((message) => message.content), [
      '迁移问题', '迁移回答',
    ]);
    assert.deepEqual(first.get('group:expired'), []);
    assert.equal(first.getStats().messages, 2);
    first.close();

    const second = new QqMemoryStore({
      databaseFilePath,
      legacyFilePath,
      now: () => now,
    });
    await second.load();
    assert.equal(second.getStats().messages, 2);
    second.close();
  });
});

test('SQLite QQ 记忆会清理过期记录并淘汰最久未更新会话', async () => {
  await withTemporaryDirectory(async (directory) => {
    let now = 1_000;
    const store = new QqMemoryStore({
      databaseFilePath: path.join(directory, 'qq-memory.sqlite'),
      maxConversations: 2,
      ttlMs: 100,
      now: () => now,
    });
    await store.load();
    store.appendExchange('private:a', '问 A', '答 A');
    now += 1;
    store.appendExchange('private:b', '问 B', '答 B');
    now += 1;
    store.appendExchange('private:c', '问 C', '答 C');

    assert.deepEqual(store.get('private:a'), []);
    assert.equal(store.size, 2);

    now += 200;
    assert.equal(store.size, 0);
    assert.equal(store.getStats().messages, 0);
    store.close();
  });
});

test('滚动摘要后模型只读取近期原文且 SQLite 仍保留被摘要原文', async () => {
  await withTemporaryDirectory(async (directory) => {
    const databaseFilePath = path.join(directory, 'qq-memory.sqlite');
    const store = new QqMemoryStore({
      databaseFilePath,
      summaryTriggerMessages: 8,
      summaryKeepMessages: 4,
      maxMessages: 20,
    });
    await store.load();
    for (let index = 1; index <= 4; index += 1) {
      store.appendExchange('group:g1', `问题 ${index}`, `回答 ${index}`);
    }

    let capturedSnapshot;
    const updated = await store.scheduleSummary('group:g1', async (snapshot) => {
      capturedSnapshot = snapshot;
      return '用户正在连续测试问题，机器人已逐一回答。';
    });

    assert.equal(updated, true);
    assert.deepEqual(capturedSnapshot.messages.map((message) => message.content), [
      '问题 1', '回答 1', '问题 2', '回答 2',
    ]);
    assert.equal(store.getSummary('group:g1'), '用户正在连续测试问题，机器人已逐一回答。');
    assert.deepEqual(store.get('group:g1').map((message) => message.content), [
      '问题 3', '回答 3', '问题 4', '回答 4',
    ]);
    assert.deepEqual(store.getStats(), {
      conversations: 1,
      messages: 8,
      summaries: 1,
      groupMembers: 0,
    });
    store.close();

    const reopened = new QqMemoryStore({ databaseFilePath });
    await reopened.load();
    assert.equal(reopened.getSummary('group:g1'), '用户正在连续测试问题，机器人已逐一回答。');
    assert.deepEqual(reopened.get('group:g1').map((message) => message.content), [
      '问题 3', '回答 3', '问题 4', '回答 4',
    ]);
    reopened.close();
  });
});

test('普通群消息可连续观察，并持久记录成员昵称变化', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new QqMemoryStore({
      databaseFilePath: path.join(directory, 'qq-memory.sqlite'),
      summaryTriggerMessages: 3,
      summaryKeepMessages: 1,
    });
    await store.load();
    store.recordGroupMember('g1', 'u1', '旧昵称');
    store.appendObservation('group:g1', '当前发言人：旧昵称（成员-a）\n当前消息：第一句');
    store.recordGroupMember('g1', 'u1', '新昵称');
    store.appendObservation('group:g1', '当前发言人：新昵称（成员-a）\n当前消息：第二句');
    store.recordGroupMember('g1', 'u2', '另一人');
    store.appendObservation('group:g1', '当前发言人：另一人（成员-b）\n当前消息：第三句');

    assert.deepEqual(store.get('group:g1').map((message) => message.role), [
      'user', 'user', 'user',
    ]);
    const members = store.getGroupMembers('g1');
    assert.equal(members.length, 2);
    assert.equal(members.find((member) => member.currentName === '新昵称').messageCount, 2);
    assert.deepEqual(
      members.find((member) => member.currentName === '新昵称').knownNames,
      ['旧昵称', '新昵称'],
    );

    const snapshot = store.getSummarySnapshot('group:g1');
    assert.equal(snapshot.messages.length, 2);
    store.close();
  });
});
