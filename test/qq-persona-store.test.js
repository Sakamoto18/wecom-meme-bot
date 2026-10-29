import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { QqPersonaStore } from '../src/qq-persona-store.js';

async function withTemporaryDirectory(task) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qq-persona-test-'));
  try {
    await task(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('人格补充必须经过确认，普通聊天不会写入人格库', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new QqPersonaStore({
      databaseFilePath: path.join(directory, 'persona.sqlite'),
    });
    await store.load();
    assert.equal(store.getActive('global', 'global'), null);
    const pending = store.createPending({
      scopeType: 'global',
      scopeId: 'global',
      actorUserId: 'admin',
      sourceText: '记住角色习惯：回答简短一点',
      profile: { styleRules: ['回答简短一点'] },
    });
    assert.equal(pending.status, 'pending');
    assert.equal(store.getActive('global', 'global'), null);
    const active = store.approve(pending.id, 'admin');
    assert.equal(active.version, 1);
    assert.deepEqual(active.profile.styleRules, ['回答简短一点']);
    store.close();
  });
});

test('人格版本可以回退且新版本保持可审计', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new QqPersonaStore({
      databaseFilePath: path.join(directory, 'persona.sqlite'),
    });
    await store.load();
    const first = store.createPending({
      scopeType: 'user', scopeId: 'u1', actorUserId: 'u1',
      sourceText: '记住我的口癖：少复述', profile: { styleRules: ['少复述'] },
    });
    store.approve(first.id, 'u1');
    const second = store.createPending({
      scopeType: 'user', scopeId: 'u1', actorUserId: 'u1',
      sourceText: '记住我的口癖：结论先说', profile: { styleRules: ['结论先说'] },
    });
    store.approve(second.id, 'u1');
    const restored = store.revertToVersion('user', 'u1', 1, 'u1');
    assert.equal(restored.version, 3);
    assert.deepEqual(restored.profile.styleRules, ['少复述']);
    assert.equal(store.listVersions('user', 'u1').length, 3);
    store.close();
  });
});

test('人格上下文按全局、群、用户范围合并并限制长度', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new QqPersonaStore({
      databaseFilePath: path.join(directory, 'persona.sqlite'),
      maxContextCharacters: 500,
    });
    await store.load();
    for (const [scopeType, scopeId, actorUserId, rule] of [
      ['global', 'global', 'admin', '保留角色语气'],
      ['group', 'g1', 'admin', '当前群简短回复'],
      ['user', 'u1', 'u1', '用户偏好结论先说'],
    ]) {
      const pending = store.createPending({
        scopeType, scopeId, actorUserId, sourceText: rule, profile: { styleRules: [rule] },
      });
      store.approve(pending.id, actorUserId);
    }
    const context = store.formatContext(store.getProfilesFor({ userId: 'u1', groupId: 'g1' }));
    assert.match(context, /全局/);
    assert.match(context, /当前群/);
    assert.match(context, /结论先说/);
    assert.match(context, /询问、测试或质疑口癖是否生效时，必须原样示范/);
    assert.match(context, /朋友间可以按当前语境接自嘲、假夸和互损/);
    assert.ok(context.length <= 500);
    store.close();
  });
});

test('全局人格可以生成不受普通上下文上限截断的最高优先级提示', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new QqPersonaStore({
      databaseFilePath: path.join(directory, 'persona.sqlite'),
      maxContextCharacters: 500,
    });
    await store.load();
    const pending = store.createPending({
      scopeType: 'global',
      scopeId: 'global',
      actorUserId: 'admin',
      sourceText: '完整全局人格',
      profile: {
        styleRules: [
          `第一条全局规则：保留短句和互联网口语。${'a'.repeat(150)}`,
          `第二条全局规则：先回应当前问题，再按语境加入角色化表达。${'b'.repeat(150)}`,
          `第三条全局规则：不要把上一轮答案当成固定模板。${'c'.repeat(150)}`,
        ],
      },
    });
    const active = store.approve(pending.id, 'admin');
    const priority = store.formatPriorityContext(active);
    assert.match(priority, /全局人格｜最高业务优先级/);
    assert.match(priority, /优先于普通人格补充、群聊语感、历史记忆/);
    assert.match(priority, /第三条全局规则/);
    assert.ok(priority.length > 500);
    store.close();
  });
});
