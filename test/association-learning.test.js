import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemeKnowledgeStore } from '../src/meme-knowledge.js';
import { learnTextAssociation } from '../src/association-learning.js';
import { generateConversationReply } from '../src/reply-engine.js';

const teaching = '肯尼迪被爆头不就是脑洞大开吗？你这都关联不起来吗';
const entry = { action: 'learn', trigger: '肯尼迪被爆头', target: '脑洞大开',
  mechanism: '把头部开洞与形容想象力的成语作字面双关', aliases: ['肯尼迪', '被爆头'] };
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'taught-association-'));
  const file = path.join(dir, 'memory.sqlite');
  const store = new MemeKnowledgeStore({ databaseFilePath: file });
  return { store, file, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('用户教学持久化，重启后完整中文问句可召回，群与私聊共用全局关联', async () => {
  const f = fixture();
  try {
    const result = await learnTextAssociation({ text: teaching, store: f.store,
      chatClient: { isConfigured: true, complete: async () => JSON.stringify(entry) } });
    assert.equal(result.action, 'learn');
    f.store.close();
    const reopened = new MemeKnowledgeStore({ databaseFilePath: f.file });
    try {
      assert.equal(reopened.lookupTaughtAssociations('global', '说到肯尼迪你想到啥')[0].target, '脑洞大开');
      // No group/user identifier participates in storage or recall.
      assert.equal(reopened.lookupTaughtAssociations('global', '肯尼迪')[0].target, '脑洞大开');
      assert.deepEqual(reopened.lookupTaughtAssociations('global', '今天吃什么'), []);
      const forgotten = await learnTextAssociation({ text: '别再把肯尼迪被爆头联想到脑洞大开', store: reopened,
        chatClient: { isConfigured: true, complete: async () => JSON.stringify({ ...entry, action: 'forget' }) } });
      assert.equal(forgotten.action, 'forget');
      assert.deepEqual(reopened.lookupTaughtAssociations('global', '肯尼迪'), []);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('普通聊天不调用提取，模型编出的触发词或坏 JSON 不写记忆', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const client = { isConfigured: true, complete: async () => { calls++; return JSON.stringify(entry); } };
    assert.equal(await learnTextAssociation({ text: '今天天气真好', store: f.store, chatClient: client }), null);
    assert.equal(calls, 0);
    for (const answer of ['bad json', JSON.stringify({ ...entry, target: '原文不存在的联想' }), '{"action":"none"}']) {
      client.complete = async () => answer;
      assert.equal(await learnTextAssociation({ text: teaching, store: f.store, chatClient: client }), null);
    }
    assert.deepEqual(f.store.lookupTaughtAssociations('global', '肯尼迪'), []);
  } finally { f.close(); }
});

test('群里教学后另一个用户私聊无历史仍召回，当前教学不进入纯攻击路由', async () => {
  const f = fixture();
  try {
    const calls = [];
    const chatClient = { isConfigured: true, async complete(_history, _text, options) {
      calls.push(options);
      return options.usageSource === 'association-learning' ? JSON.stringify(entry) : '这脑洞确实开过头了。';
    } };
    const first = await generateConversationReply({ content: teaching, currentQuestion: teaching, modelInput: teaching,
      conversationId: 'group:a', memeKnowledge: f.store, chatClient, webSearchEnabled: false });
    assert.equal(first.associationLearningAction, 'learn');
    assert.ok(calls.every((call) => !call.usageSource.startsWith('attack-reply')));
    calls.length = 0;
    const text = '说到肯尼迪你又想起啥';
    const second = await generateConversationReply({ content: text, currentQuestion: text, modelInput: text,
      conversationId: 'private:b', memeKnowledge: f.store, chatClient, webSearchEnabled: false, history: [] });
    assert.equal(second.taughtAssociationsUsed, 1);
    assert.ok(calls.every((call) => call.usageSource !== 'association-learning'));
    const generation = calls.find((call) => call.usageSource === 'conversation-reply');
    assert.match(generation.prioritySystemPrompt, /脑洞大开/);
    assert.match(generation.prioritySystemPrompt, /不追加笑点评分、训人或无关比喻/);
  } finally { f.close(); }
});
