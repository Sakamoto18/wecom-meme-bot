import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { QqGroupMemory } from '../src/group-memory.js';

async function withTemporaryDirectory(task) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qq-group-memory-test-'));
  try {
    await task(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function memberId(userId) {
  return createHash('sha256').update(String(userId)).digest('hex').slice(0, 6);
}

function createMemory(directory, overrides = {}) {
  let now = 1_000_000;
  const memory = new QqGroupMemory({
    databaseFilePath: path.join(directory, 'qq-group-memory.sqlite'),
    enabledGroups: ['g1'],
    styleGroups: ['g1'],
    now: () => now,
    logger: { log() {}, warn() {} },
    ...overrides,
  });
  return {
    memory,
    advance(milliseconds) {
      now += milliseconds;
      return now;
    },
    get now() {
      return now;
    },
  };
}

test('精确引用和话题内上下文不会串入并行讨论', async () => {
  await withTemporaryDirectory(async (directory) => {
    const clock = createMemory(directory);
    const add = (event) => {
      clock.advance(1_000);
      return clock.memory.recordEvent({
        groupId: 'g1',
        senderName: event.userId,
        createdAt: clock.now,
        ...event,
      });
    };

    add({ userId: 'u1', messageId: 'game-1', text: '今晚七点开黑，谁来打排位' });
    add({ userId: 'u2', messageId: 'movie-1', text: '我晚上想去看电影，哪部好看' });
    add({ userId: 'u3', messageId: 'movie-2', text: '电影院那部科幻片挺好看，视觉效果不错' });
    add({ userId: 'u1', messageId: 'game-2', text: '排位还缺一个辅助，有人来吗' });
    const quoted = add({
      userId: 'u4',
      messageId: 'movie-3',
      text: '你们刚说的电影是哪部',
      quotedMessageId: 'movie-2',
      quotedText: '电影院那部科幻片挺好看，视觉效果不错',
    });

    assert.equal(quoted.confidence, 1);
    assert.equal(quoted.status, 'matched');
    const context = clock.memory.resolveReplyContext({ groupId: 'g1', messageId: 'movie-3' });
    assert.equal(context.status, 'matched');
    assert.ok(context.contextMessages >= 1);
    const transcript = context.history.map((message) => message.content).join('\n');
    assert.match(transcript, /电影/);
    assert.doesNotMatch(transcript, /开黑|排位|辅助/);
    assert.match(context.prompt, /不要把旁边另一场讨论/);
    clock.memory.close();
  });
});

test('话题不确定时主动接话只拿到短当前语境，明确回复可走回退上下文', async () => {
  await withTemporaryDirectory(async (directory) => {
    const clock = createMemory(directory);
    const add = (event) => {
      clock.advance(1_000);
      return clock.memory.recordEvent({
        groupId: 'g1',
        senderName: event.userId,
        createdAt: clock.now,
        ...event,
      });
    };
    add({ userId: 'u1', messageId: 'a1', text: '这个版本更新之后有点卡' });
    add({ userId: 'u1', messageId: 'a2', text: '我先回滚到上一版' });
    const unrelated = add({ userId: 'u2', messageId: 'x1', text: '中午吃啥，有人点外卖吗' });

    assert.equal(unrelated.status, 'ambiguous');
    const silentContext = clock.memory.resolveReplyContext({
      groupId: 'g1',
      messageId: 'x1',
      allowDirectFallback: false,
    });
    assert.equal(silentContext.status, 'ambiguous');
    assert.deepEqual(silentContext.history, []);

    const directContext = clock.memory.resolveReplyContext({
      groupId: 'g1',
      messageId: 'x1',
      allowDirectFallback: true,
    });
    assert.equal(directContext.status, 'direct-fallback');
    assert.ok(directContext.contextMessages <= 12);
    assert.ok(directContext.contextCharacters <= 6_000);
    assert.match(directContext.prompt, /不要引用未确认的旧话题/);
    clock.memory.close();
  });
});

test('同一发言者开启无关新话题时不会硬并进上一场讨论', async () => {
  await withTemporaryDirectory(async (directory) => {
    const clock = createMemory(directory);
    const add = (event) => {
      clock.advance(1_000);
      return clock.memory.recordEvent({
        groupId: 'g1',
        senderName: event.userId,
        createdAt: clock.now,
        ...event,
      });
    };
    const first = add({ userId: 'u1', messageId: 'version-1', text: '新版本更新之后一直卡顿，要不要回滚' });
    const sameTopic = add({ userId: 'u2', messageId: 'version-2', text: '我也遇到更新后卡顿，先回滚到上一版看看' });
    const unrelated = add({ userId: 'u1', messageId: 'lunch-1', text: '中午吃啥，有人点外卖吗' });

    assert.equal(sameTopic.topicId, first.topicId);
    assert.notEqual(unrelated.topicId, first.topicId);
    assert.equal(unrelated.status, 'ambiguous');
    clock.memory.close();
  });
});

test('关闭话题在保留期内仍可用引用续聊，超过保留期后清除', async () => {
  await withTemporaryDirectory(async (directory) => {
    const clock = createMemory(directory, {
      topicIdleMs: 60 * 1_000,
      topicKeepClosedMs: 10 * 60 * 1_000,
    });
    const add = (event) => clock.memory.recordEvent({
      groupId: 'g1',
      senderName: event.userId,
      createdAt: clock.now,
      ...event,
    });
    add({ userId: 'u1', messageId: 'a1', text: '周末去爬山吗，路线已经选好了' });
    clock.advance(1_000);
    add({ userId: 'u2', messageId: 'a2', text: '爬山路线发我看看，难度高不高' });
    clock.advance(5 * 60 * 1_000);
    const continued = add({
      userId: 'u3',
      messageId: 'a3',
      text: '我看了那个爬山路线，新手也能走',
      quotedMessageId: 'a1',
      quotedText: '周末去爬山吗，路线已经选好了',
    });
    assert.equal(continued.status, 'matched');
    assert.equal(continued.confidence, 1);
    clock.memory.close();
  });
});

test('群级语感画像使用全部历史、清洗敏感内容并支持参考 Bot', async () => {
  await withTemporaryDirectory(async (directory) => {
    const calls = [];
    const clock = createMemory(directory, {
      referenceBotsByGroup: new Map([['g1', new Set(['reference-bot'])]]),
      chatClient: {
        async complete(history, input, options) {
          calls.push({ history, input, options });
          return JSON.stringify({
            catchphrases: ['确实，笑死'],
            memeMechanisms: ['先附和再补一句反话'],
            banterMechanisms: ['直接拆台，不铺垫'],
            rhythmRules: ['多数一到两短句'],
          });
        },
      },
    });
    for (let index = 0; index < 220; index += 1) {
      clock.advance(1_000);
      clock.memory.recordEvent({
        groupId: 'g1',
        userId: `u${index % 7}`,
        senderName: `群友${index % 7}`,
        messageId: `human-${index}`,
        createdAt: clock.now,
        text: index % 4 === 0
          ? '确实，笑死'
          : `这版本更新后有点卡，我先回滚了 https://example.com/${index}`,
      });
    }
    for (let index = 0; index < 4; index += 1) {
      clock.advance(1_000);
      clock.memory.recordEvent({
        groupId: 'g1',
        userId: 'u1',
        senderName: '群友1',
        messageId: `noise-image-${index}`,
        createdAt: clock.now,
        text: '（发送了一张图片）',
      });
      clock.advance(1_000);
      clock.memory.recordEvent({
        groupId: 'g1',
        userId: 'u2',
        senderName: '群友2',
        messageId: `noise-mention-${index}`,
        createdAt: clock.now,
        text: '@某人(123456789) 如何评价',
      });
    }
    clock.advance(1_000);
    clock.memory.recordEvent({
      groupId: 'g1',
      userId: 'reference-bot',
      senderName: '参考Bot',
      messageId: 'ref-1',
      createdAt: clock.now,
      text: '别急，先看看缓存，再回滚也不迟',
    });

    assert.equal(await clock.memory.refreshStyleProfile('g1'), true);
    const profile = clock.memory.loadStyleProfile('g1');
    assert.equal(profile.sourceCount, 228);
    assert.equal(profile.version, 3);
    assert.ok(profile.semanticCard.catchphrases.includes('确实，笑死'));
    assert.ok(profile.styleRules.some((rule) => rule.includes('中位长度')));
    assert.ok(profile.repeatedPhrases.includes('确实，笑死'));
    assert.ok(!profile.repeatedPhrases.includes('（发送了一张图片）'));
    assert.ok(profile.referenceCount, 'reference bot event should be counted');
    const styleCalls = calls.filter((call) => call.options.usageSource === 'group-style-card');
    assert.equal(styleCalls.length, 1);
    assert.doesNotMatch(styleCalls[0].input, /https:\/\/example\.com/);

    const prompt = clock.memory.buildStylePrompt({
      groupId: 'g1',
      query: '缓存回滚怎么处理',
    });
    assert.match(prompt, /本群真实语感参考/);
    assert.match(prompt, /先学他们怎么接话/);
    assert.match(prompt, /接梗机制/);
    assert.match(prompt, /确实，笑死/);
    assert.match(prompt, /参考Bot/);
    assert.doesNotMatch(prompt, /https?:\/\//);
    assert.doesNotMatch(prompt, /发送了一张图片|如何评价|@某人/);
    assert.ok(prompt.indexOf('接梗机制') >= 0);
    assert.ok(prompt.indexOf('接梗机制') < prompt.indexOf('真实发言节奏参考'));

    const other = createMemory(directory, { styleGroups: ['g2'] });
    assert.equal(other.memory.buildStylePrompt({ groupId: 'g2', query: '版本' }), '');
    other.memory.close();
    clock.memory.close();
  });
});

test('话题摘要异步更新标题和摘要，回复路径不等待摘要', async () => {
  await withTemporaryDirectory(async (directory) => {
    const prompts = [];
    const clock = createMemory(directory, {
      summaryTriggerMessages: 4,
      summaryIdleMs: 60_000,
      chatClient: {
        async complete(history, input, options) {
          prompts.push({ history, input, options });
          return JSON.stringify({
            title: '版本更新卡顿',
            summary: '群友在讨论新版本更新后的卡顿和回滚。',
            keywords: ['版本', '更新', '卡顿', '回滚'],
            status: 'open',
          });
        },
      },
    });
    for (let index = 0; index < 4; index += 1) {
      clock.advance(1_000);
      const result = clock.memory.recordEvent({
        groupId: 'g1',
        userId: `u${index % 2}`,
        senderName: `群友${index % 2}`,
        messageId: `summary-${index}`,
        createdAt: clock.now,
        text: `版本更新后有点卡顿，我准备回滚，第${index}次测试`,
      });
      assert.ok(result.topicId);
    }
    await clock.memory.flush();
    const topic = clock.memory.ensureOpen().prepare(`
      SELECT title, summary, keywords_json FROM qq_group_topics ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(topic.title, '版本更新卡顿');
    assert.match(topic.summary, /卡顿/);
    assert.match(topic.keywords_json, /回滚/);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].options.usageSource, 'group-topic-summary');
    clock.memory.close();
  });
});

test('旧 QQ 记忆可回填群事件、成员映射、引用作者和机器人自身消息', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = path.join(directory, 'qq-memory.sqlite');
    const source = new DatabaseSync(sourcePath);
    source.exec(`
      CREATE TABLE qq_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE qq_group_members (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        speaker_id TEXT NOT NULL
      );
      CREATE TABLE qq_group_member_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    source.prepare('INSERT INTO qq_group_members(group_id, user_id, speaker_id) VALUES (?, ?, ?)')
      .run('g1', 'u1', memberId('u1'));
    source.prepare('INSERT INTO qq_group_members(group_id, user_id, speaker_id) VALUES (?, ?, ?)')
      .run('g1', 'u2', memberId('u2'));
    source.prepare('INSERT INTO qq_group_members(group_id, user_id, speaker_id) VALUES (?, ?, ?)')
      .run('g1', 'reference-bot', memberId('reference-bot'));
    source.prepare(`
      INSERT INTO qq_messages(conversation_id, role, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      'group:g1',
      'user',
      `当前发言人：甲（成员-${memberId('u1')}）\n引用消息作者：乙（成员-${memberId('u2')}）\n引用消息内容：旧版本也有这个问题\n当前消息：新版本卡顿还是没修`,
      1_000,
    );
    source.prepare(`
      INSERT INTO qq_messages(conversation_id, role, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      'group:g1',
      'assistant',
      '当前发言人：甲（成员-xxx）\n当前消息：新版本卡顿还是没修\n机器人回复：先把缓存清掉再试。',
      2_000,
    );
    source.prepare(`
      INSERT INTO qq_messages(conversation_id, role, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      'group:g2',
      'user',
      `当前发言人：丙（成员-${memberId('u3')}）\n当前消息：这个群不应该被回填`,
      3_000,
    );
    source.prepare(`
      INSERT INTO qq_group_member_observations(group_id, user_id, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      'g1',
      'u1',
      `当前发言人：甲（成员-${memberId('u1')}）\n当前消息：新版本卡顿还是没修`,
      1_200,
    );
    source.prepare(`
      INSERT INTO qq_group_member_observations(group_id, user_id, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      'g1',
      'u2',
      `当前发言人：乙（成员-${memberId('u2')}）\n当前消息：这个版本的回滚包我放群里了`,
      4_000,
    );
    source.close();

    const clock = createMemory(directory, {
      referenceBotsByGroup: new Map([['g1', new Set(['reference-bot'])]]),
    });
    const result = await clock.memory.backfillFromQqMemoryDatabase(sourcePath, {
      groups: ['g1'],
      rebuildTopics: true,
      recentTopicCutoff: 0,
    });
    assert.equal(result.inserted, 3);
    assert.ok(result.topics >= 1);

    const rows = clock.memory.ensureOpen().prepare(`
      SELECT group_id, user_id, sender_name, quoted_user_id, quoted_text, text, author_type
      FROM qq_group_events ORDER BY id ASC
    `).all();
    assert.deepEqual(rows.map((row) => row.group_id), ['g1', 'g1', 'g1']);
    assert.equal(rows[0].user_id, 'u1');
    assert.equal(rows[0].quoted_user_id, 'u2');
    assert.equal(rows[0].quoted_text, '旧版本也有这个问题');
    assert.equal(rows[1].author_type, 'own_bot');
    assert.equal(rows[1].text, '先把缓存清掉再试。');
    assert.equal(rows[2].user_id, 'u2');
    assert.equal(rows[2].text, '这个版本的回滚包我放群里了');

    const again = await clock.memory.backfillFromQqMemoryDatabase(sourcePath, {
      groups: ['g1'],
      rebuildTopics: true,
      recentTopicCutoff: 0,
    });
    assert.equal(again.inserted, 0);
    clock.memory.close();
  });
});
