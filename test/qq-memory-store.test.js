import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
    assert.deepEqual(
      members.find((member) => member.currentName === '新昵称').confirmedNames,
      ['旧昵称', '新昵称'],
    );

    const snapshot = store.getSummarySnapshot('group:g1');
    assert.equal(snapshot.messages.length, 2);
    store.close();
  });
});

test('别人艾特只登记待确认身份，成员本人发言后才确认昵称别名', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new QqMemoryStore({
      databaseFilePath: path.join(directory, 'qq-memory.sqlite'),
    });
    await store.load();
    store.recordGroupMember('g1', 'target', '别人填写的昵称', {
      countMessage: false,
      confirmIdentity: false,
    });
    let member = store.getGroupMembers('g1')[0];
    assert.equal(member.identityConfirmed, false);
    assert.deepEqual(member.confirmedNames, []);
    assert.deepEqual(store.getGroupMemberAliases('g1'), {});

    store.recordGroupMember('g1', 'target', '', {
      countMessage: true,
      confirmIdentity: true,
    });
    member = store.getGroupMembers('g1')[0];
    assert.equal(member.identityConfirmed, true);
    assert.deepEqual(member.confirmedNames, []);

    store.recordGroupMember('g1', 'target', '本人昵称', {
      countMessage: true,
      confirmIdentity: true,
    });
    member = store.getGroupMembers('g1')[0];
    assert.deepEqual(member.confirmedNames, ['本人昵称']);
    assert.deepEqual(Object.values(store.getGroupMemberAliases('g1')), ['本人昵称']);
    store.close();
  });
});

test('旧版群成员表升级后按历史发言次数恢复已确认身份', async () => {
  await withTemporaryDirectory(async (directory) => {
    const databaseFilePath = path.join(directory, 'qq-memory.sqlite');
    const legacy = new DatabaseSync(databaseFilePath);
    legacy.exec(`
      CREATE TABLE qq_group_members (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        speaker_id TEXT NOT NULL,
        current_name TEXT NOT NULL DEFAULT '',
        known_names TEXT NOT NULL DEFAULT '[]',
        message_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY(group_id, user_id)
      );
    `);
    legacy.prepare(`
      INSERT INTO qq_group_members(
        group_id, user_id, speaker_id, current_name, known_names,
        message_count, first_seen_at, last_seen_at
      ) VALUES ('g1', 'u1', 'abcdef', '本人昵称', '["本人昵称"]', 3, 1, 2)
    `).run();
    legacy.close();

    const store = new QqMemoryStore({ databaseFilePath });
    await store.load();
    const member = store.getGroupMembers('g1')[0];
    assert.equal(member.identityConfirmed, true);
    assert.deepEqual(member.confirmedNames, ['本人昵称']);
    store.close();
  });
});

test('群成员画像独立持久化，不随会话消息上限或 TTL 清理', async () => {
  await withTemporaryDirectory(async (directory) => {
    let now = 1_000;
    const databaseFilePath = path.join(directory, 'qq-memory.sqlite');
    const store = new QqMemoryStore({
      databaseFilePath,
      maxStoredMessages: 2,
      ttlMs: 100,
      memberSummaryTriggerMessages: 4,
      memberSummaryKeepMessages: 1,
      now: () => now,
    });
    await store.load();
    store.recordGroupMember('g1', 'u1', '小蓝');
    for (const content of ['我喜欢蓝色', '我养了一只猫', '我平时写前端', '今天吃面']) {
      store.appendMemberObservation('g1', 'u1', content);
      store.appendObservation('group:g1', content);
      now += 1;
    }

    let snapshot;
    assert.equal(await store.scheduleMemberMemory('g1', 'u1', async (value) => {
      snapshot = value;
      return '稳定偏好：喜欢蓝色；养了一只猫；平时写前端。';
    }), true);
    assert.deepEqual(snapshot.observations, ['我喜欢蓝色', '我养了一只猫', '我平时写前端']);
    assert.equal(store.getStats().messages, 2);
    assert.match(store.getGroupMemberMemories('g1', ['u1'])[0].memory, /喜欢蓝色/);

    now += 200;
    assert.equal(store.size, 0);
    assert.equal(store.getStats().messages, 0);
    assert.match(store.getGroupMemberMemories('g1', ['u1'])[0].memory, /养了一只猫/);
    store.close();

    const reopened = new QqMemoryStore({ databaseFilePath, now: () => now });
    await reopened.load();
    assert.match(reopened.getGroupMemberMemories('g1', ['u1'])[0].memory, /写前端/);
    reopened.close();
  });
});

test('成员历史检索可越过模型近期窗口读取 SQLite 中的较早原文', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new QqMemoryStore({
      databaseFilePath: path.join(directory, 'qq-memory.sqlite'),
      maxMessages: 2,
      maxStoredMessages: 50,
    });
    await store.load();
    const speakerId = createHash('sha256').update('u1').digest('hex').slice(0, 6);
    store.appendObservation('group:g1', `当前发言人：小蓝（成员-${speakerId}）\n当前消息：最早说过喜欢蓝色`);
    for (let index = 0; index < 6; index += 1) {
      store.appendObservation('group:g1', `当前发言人：其他人（成员-ffffff）\n当前消息：消息 ${index}`);
    }

    assert.doesNotMatch(store.get('group:g1').map((entry) => entry.content).join('\n'), /喜欢蓝色/);
    const history = store.getGroupMemberHistory('g1', ['u1']);
    assert.equal(history.length, 1);
    assert.match(history[0].content, /最早说过喜欢蓝色/);
    store.close();
  });
});

test('定时维护只清理已摘要旧原文，并保留每会话最低窗口', async () => {
  await withTemporaryDirectory(async (directory) => {
    let now = 1_000;
    const store = new QqMemoryStore({
      databaseFilePath: path.join(directory, 'qq-memory.sqlite'),
      maxStoredMessages: 50,
      maxTotalStoredMessages: 50,
      minStoredMessagesPerConversation: 1,
      rawMessageRetentionMs: 100,
      maintenanceIntervalMs: 50,
      summaryTriggerMessages: 4,
      summaryKeepMessages: 1,
      now: () => now,
    });
    await store.load();
    for (let index = 1; index <= 4; index += 1) {
      store.appendObservation('group:g1', `旧消息 ${index}`);
      now += 1;
    }
    assert.equal(await store.scheduleSummary('group:g1', async () => '旧消息已摘要。'), true);

    now += 200;
    store.appendObservation('group:g1', '当前消息');
    assert.deepEqual(store.get('group:g1').map((message) => message.content), [
      '旧消息 4',
      '当前消息',
    ]);
    assert.equal(store.getSummary('group:g1'), '旧消息已摘要。');
    store.close();
  });
});

test('全库硬上限优先淘汰已摘要原文而不删除摘要', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new QqMemoryStore({
      databaseFilePath: path.join(directory, 'qq-memory.sqlite'),
      maxStoredMessages: 50,
      maxTotalStoredMessages: 4,
      minStoredMessagesPerConversation: 1,
      rawMessageRetentionMs: Number.MAX_SAFE_INTEGER,
      maintenanceIntervalMs: Number.MAX_SAFE_INTEGER,
      summaryTriggerMessages: 4,
      summaryKeepMessages: 1,
    });
    await store.load();
    for (const conversationId of ['group:g1', 'group:g2']) {
      for (let index = 1; index <= 4; index += 1) {
        store.appendObservation(conversationId, `${conversationId} 消息 ${index}`);
      }
      await store.scheduleSummary(conversationId, async () => `${conversationId} 摘要`);
    }

    const result = store.performMaintenance({ force: true });
    assert.equal(result.overflowMessagesRemoved, 4);
    assert.equal(store.getStats().messages, 4);
    assert.equal(store.getSummary('group:g1'), 'group:g1 摘要');
    assert.equal(store.getSummary('group:g2'), 'group:g2 摘要');
    store.close();
  });
});

test('摘要服务不可用时全库硬上限仍会保底清理原文', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new QqMemoryStore({
      databaseFilePath: path.join(directory, 'qq-memory.sqlite'),
      maxStoredMessages: 50,
      maxTotalStoredMessages: 3,
      minStoredMessagesPerConversation: 1,
      rawMessageRetentionMs: Number.MAX_SAFE_INTEGER,
      maintenanceIntervalMs: Number.MAX_SAFE_INTEGER,
    });
    await store.load();
    for (const conversationId of ['group:g1', 'group:g2']) {
      for (let index = 1; index <= 3; index += 1) {
        store.appendObservation(conversationId, `${conversationId} 未摘要消息 ${index}`);
      }
    }

    const result = store.performMaintenance({ force: true });
    assert.equal(result.overflowMessagesRemoved, 3);
    assert.equal(store.getStats().messages, 3);
    assert.ok(store.get('group:g1').length >= 1);
    assert.ok(store.get('group:g2').length >= 1);
    store.close();
  });
});
