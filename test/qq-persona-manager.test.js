import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { QqPersonaStore } from '../src/qq-persona-store.js';
import { QqPersonaManager, parsePersonaRequest } from '../src/qq-persona-manager.js';

async function withManager(task) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qq-persona-manager-test-'));
  const store = new QqPersonaStore({ databaseFilePath: path.join(directory, 'persona.sqlite') });
  await store.load();
  const manager = new QqPersonaManager({ store, adminUsers: ['admin'] });
  try {
    await task({ store, manager });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('自然语言训练先生成待确认草稿，确认后写入用户范围', async () => {
  await withManager(async ({ store, manager }) => {
    assert.deepEqual(parsePersonaRequest('记住我的口癖：结论先说'), {
      action: 'draft', kind: 'phrase', content: '结论先说',
    });
    const payload = { userId: 'u1', groupId: 'g1', messageType: 'group', text: '记住我的口癖：结论先说' };
    const draft = manager.handle(payload);
    assert.equal(draft.mode, 'persona-pending');
    assert.equal(store.getActive('user', 'u1'), null);
    const confirmed = manager.handle({ ...payload, text: '确认保存' });
    assert.equal(confirmed.mode, 'persona-confirmed');
    assert.deepEqual(store.getActive('user', 'u1').profile.preferredPhrases, ['结论先说']);
  });
});

test('普通用户不能写入全局人格，管理员可以', async () => {
  await withManager(async ({ store, manager }) => {
    const denied = manager.handle({
      userId: 'u1', groupId: 'g1', messageType: 'group', text: '/persona global 保留冲劲',
    });
    assert.equal(denied.mode, 'persona-denied');
    assert.equal(store.getActive('global', 'global'), null);

    const adminPayload = {
      userId: 'admin', groupId: 'g1', messageType: 'group', text: '/persona global 保留冲劲',
    };
    assert.equal(manager.handle(adminPayload).mode, 'persona-pending');
    assert.equal(manager.handle({ ...adminPayload, text: '/persona save' }).mode, 'persona-confirmed');
    assert.deepEqual(store.getActive('global', 'global').profile.styleRules, ['保留冲劲']);
  });
});

test('没有待确认人格时，普通确认短句不被人格管理器截走', async () => {
  await withManager(async ({ manager }) => {
    const result = manager.handle({
      userId: 'u1', groupId: 'g1', messageType: 'group', text: '确认保存',
    });
    assert.equal(result, null);
  });
});

test('管理员自然训练默认是自己的口癖，只有明确 global 才写全局', async () => {
  await withManager(async ({ store, manager }) => {
    const payload = { userId: 'admin', groupId: 'g1', messageType: 'group', text: '记住我的角色习惯：回答短一点' };
    manager.handle(payload);
    manager.handle({ ...payload, text: '确认保存' });
    assert.equal(store.getActive('user', 'admin')?.version, 1);
    assert.equal(store.getActive('global', 'global'), null);
  });
});

test('连续确认的训练内容会合并到同一范围，不会覆盖旧口癖', async () => {
  await withManager(async ({ store, manager }) => {
    const payload = { userId: 'u1', groupId: 'g1', messageType: 'group', text: '记住我的口癖：先说结论' };
    manager.handle(payload);
    manager.handle({ ...payload, text: '确认保存' });
    manager.handle({ ...payload, text: '记住我的口癖：保留一点冲劲' });
    manager.handle({ ...payload, text: '确认保存' });
    assert.deepEqual(store.getActive('user', 'u1').profile.preferredPhrases, [
      '先说结论', '保留一点冲劲',
    ]);
  });
});

test('人格上下文只读取已确认配置，且包含当前群和当前用户范围', async () => {
  await withManager(async ({ manager }) => {
    manager.handle({ userId: 'admin', groupId: 'g1', messageType: 'group', text: '/persona global 保留角色语气' });
    manager.handle({ userId: 'admin', groupId: 'g1', messageType: 'group', text: '/persona save' });
    manager.handle({ userId: 'u1', groupId: 'g1', messageType: 'group', text: '记住我的口癖：先说结论' });
    manager.handle({ userId: 'u1', groupId: 'g1', messageType: 'group', text: '确认保存' });
    const context = manager.contextFor({ from: { userid: 'u1' }, chattype: 'group', chatid: 'g1' });
    assert.match(context, /保留角色语气/);
    assert.match(context, /先说结论/);
  });
});
