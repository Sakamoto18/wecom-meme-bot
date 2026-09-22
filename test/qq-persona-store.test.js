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
    assert.ok(context.length <= 500);
    store.close();
  });
});

