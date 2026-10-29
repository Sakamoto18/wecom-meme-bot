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

test('多段完整角色卡不丢换行、尾部和内嵌示例，确认后全量注入', async () => {
  await withManager(async ({ store, manager }) => {
    const card = `性格：\n${'按当前话头接话。'.repeat(600)}\n示例：\n朋友：认真回答。\n角色：先保留关键事实，别强行玩梗。`;
    const payload = { userId: 'admin', text: `/persona global ${card}` };
    const draft = manager.handle(payload);
    assert.equal(draft.mode, 'persona-pending');
    assert.ok(draft.messages[0].text.includes(card));
    manager.handle({ ...payload, text: '/persona save' });
    const active = store.getActive('global', 'global');
    assert.deepEqual(active.profile.styleRules, [card]);
    assert.ok(store.formatPriorityContext(active).includes(card));
    assert.equal(store.getEvent(1).sourceText, payload.text);
  });
});

test('规则满额时明确拒绝追加，完整替换可确认并回退旧版本', async () => {
  await withManager(async ({ store, manager }) => {
    const rules = Array.from({ length: 20 }, (_, index) => `旧规则 ${index}`);
    const pending = store.createPending({ scopeType: 'global', scopeId: 'global', actorUserId: 'admin', sourceText: '旧卡', profile: { styleRules: rules } });
    store.approve(pending.id, 'admin');
    const payload = { userId: 'admin', text: '/persona global 新规则不能丢失' };
    const rejected = manager.handle(payload);
    assert.equal(rejected.mode, 'persona-error');
    assert.match(rejected.messages[0].text, /未保存/);
    assert.equal(store.getStats().pendingEvents, 0);
    assert.deepEqual(store.getActive('global', 'global').profile.styleRules, rules);
    const replacement = '新角色卡\n朋友互损也要回答问题';
    assert.equal(manager.handle({ ...payload, text: `/persona replace global ${replacement}` }).mode, 'persona-pending');
    assert.equal(store.getActive('global', 'global').version, 1);
    manager.handle({ ...payload, text: '/persona save' });
    assert.deepEqual(store.getActive('global', 'global').profile.styleRules, [replacement]);
    manager.handle({ ...payload, text: '/persona undo global' });
    assert.deepEqual(store.getActive('global', 'global').profile.styleRules, rules);
  });
});

test('替换不会绕过权限，过长卡片和错误范围不生成草稿', async () => {
  await withManager(async ({ store, manager }) => {
    assert.equal(manager.handle({ userId: 'u1', text: '/persona replace global 越权卡片' }).mode, 'persona-denied');
    for (const text of ['/persona replace typo 不能错存到用户', '/persona global', `/persona global ${'字'.repeat(12_001)}`]) {
      assert.equal(manager.handle({ userId: 'admin', text }).mode, 'persona-error');
    }
    assert.equal(store.getStats().pendingEvents, 0);
  });
});

test('口癖与示例满额后不再静默丢弃新输入', async () => {
  await withManager(async ({ store, manager }) => {
    const pending = store.createPending({ scopeType: 'user', scopeId: 'u1', actorUserId: 'u1', sourceText: '旧资料', profile: {
      preferredPhrases: Array.from({ length: 12 }, (_, i) => `口癖 ${i}`),
      examples: Array.from({ length: 8 }, (_, i) => ({ input: `输入 ${i}`, output: `输出 ${i}` })),
    } });
    store.approve(pending.id, 'u1');
    for (const text of ['记住我的口癖：新口癖', '/persona example 输入新问题 => 新回答']) {
      assert.equal(manager.handle({ userId: 'u1', text }).mode, 'persona-error');
    }
    assert.equal(store.getStats().pendingEvents, 0);
  });
});
