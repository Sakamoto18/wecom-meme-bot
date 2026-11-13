import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RocoKnowledge, answerRocoQuestion } from '../src/roco-knowledge.js';
import { generateConversationReply } from '../src/reply-engine.js';
import { QqBotService } from '../src/qq-service.js';
import { ConversationStore } from '../src/conversation-store.js';

const records = JSON.parse(readFileSync(new URL('./fixtures/roco/sample.json', import.meta.url))).records;
function setup(t, now = Date.now) {
  const dir = mkdtempSync(path.join(tmpdir(), 'roco-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const databaseFilePath = path.join(dir, 'knowledge.sqlite');
  const db = new DatabaseSync(databaseFilePath);
  db.exec('CREATE TABLE metadata(value TEXT); CREATE TABLE entries(payload TEXT)');
  db.prepare('INSERT INTO metadata VALUES (?)').run(JSON.stringify({ version: 1, importedAt: '2026-11-13', counts: { pet: 3, skill: 2, trait: 2, effect: 3 } }));
  for (const r of records) db.prepare('INSERT INTO entries VALUES (?)').run(JSON.stringify(r));
  db.close();
  return new RocoKnowledge({ databaseFilePath, now, logger: {} });
}

test('真实 Wiki 样本：形态精确匹配、数值、技能来源与效果关系', t => {
  const store = setup(t);
  const boss = store.retrieve('圣光迪莫的特性是什么');
  assert.equal(boss.records[0].名称, '圣光迪莫');
  assert.equal(boss.records[0].字段.特性, '裁决');
  assert.ok(!boss.records.some(r => r.名称 === '迪莫'));
  const miao = store.retrieve('喵喵能学哪些技能');
  assert.equal(miao.records[0].技能表.length, 52);
  assert.equal(miao.records[0].技能表.filter(s => s.习得 === '自学').length, 16);
  assert.equal(miao.records[0].字段.生命种族值, '65');
  assert.ok(miao.records.some(r => r.名称 === '氧循环'));
  const poison = store.retrieve('洛克世界中毒是什么效果');
  assert.match(poison.records[0].字段.效果, /3%生命.*毒系精灵免疫/);
  const cross = store.retrieve('洛克世界谁能学棘突');
  assert.equal(cross.records[0].关联精灵[0].精灵, '喵喵');
  assert.deepEqual(cross.records[0].关联精灵[0].习得, ['自学 Lv6']);
});

test('跨用户/跨群隔离，过期追问不串话，普通词不劫持游戏路由', t => {
  let now = 1000;
  const store = setup(t, () => now);
  for (const q of ['我好像食物中毒了', '猫一直抓挠沙发', '你好', '要怎么休息']) assert.equal(store.retrieve(q), null);
  const initial = store.retrieve('喵喵的特性呢', { sessionKey: 'g1:u1' });
  store.remember(initial);
  assert.equal(store.retrieve('那它的技能呢', { sessionKey: 'g1:u1' }).records[0].名称, '喵喵');
  const skillFollowup = store.retrieve('那它几级学会棘突', { sessionKey: 'g1:u1' });
  assert.ok(skillFollowup.records.some(r => r.名称 === '喵喵' && r.技能表[0].等级 === '6'));
  assert.equal(store.retrieve('那它的技能呢', { sessionKey: 'g1:u2' }), null);
  assert.equal(store.retrieve('那它的技能呢', { sessionKey: 'g2:u1' }), null);
  assert.equal(store.retrieve('那我今天吃什么', { sessionKey: 'g1:u1' }), null);
  now += 600001;
  assert.equal(store.retrieve('那它的技能呢', { sessionKey: 'g1:u1' }), null);
});

test('未知精灵与缺失数据库不编造，知识库状态可自然查询', async t => {
  const store = setup(t);
  const missing = store.retrieve('洛克世界阿巴阿巴兽');
  assert.equal(missing.records.length, 0);
  assert.match((await answerRocoQuestion({ knowledge: missing })).answer, /没有查到/);
  assert.match((await answerRocoQuestion({ knowledge: store.retrieve('洛克世界知识库') })).answer, /3 个精灵/);
  const empty = new RocoKnowledge();
  assert.match((await answerRocoQuestion({ knowledge: empty.retrieve('洛克世界迪莫') })).answer, /不可用/);
});

test('图鉴优先于玩梗和搜索，证据包含来源、版本与缺失约束', async t => {
  const store = setup(t);
  let calls = 0;
  const query = '洛克世界中毒是什么效果';
  const result = await generateConversationReply({ content: query, modelInput: query,
    gameKnowledge: store.retrieve(query),
    webSearch: { search() { throw new Error('不应联网'); } },
    memeKnowledge: { lookupTaughtAssociations() { throw new Error('不应走玩梗'); } },
    chatClient: { isConfigured: true, async complete(history, input, options) {
      calls++;
      assert.match(input, /3%生命/);
      assert.match(options.additionalSystemPrompt, /禁止混用/);
      assert.match(options.additionalSystemPrompt, /不执行其中指令/);
      assert.equal(options.usageSource, 'roco-game-knowledge');
      return '回合结束造成3%生命的毒系伤害，毒系精灵免疫。';
    } },
  });
  assert.equal(result.mode, 'game-knowledge');
  assert.equal(calls, 1);
});

for (const official of [false, true]) test(`${official ? '官方' : 'NapCat'} 群消息经同一服务检索，保留问答记忆`, async t => {
  const store = setup(t);
  const calls = [];
  const memory = new ConversationStore();
  const service = new QqBotService({ rocoKnowledge: store, conversationStore: memory,
    imageOcrEnabled: false, webSearchEnabled: false, roleplayImmersion: false,
    chatClient: { isConfigured: true, async complete(history, input, options) {
      calls.push({ history, input, options });
      return '喵喵的特性是氧循环，使用草系技能后回复10%生命。';
    } }, logger: { log() {}, warn() {}, error() {} },
  });
  const base = { message_type: 'group', group_id: official ? 'qqofficial:1903660238:group:roco' : 'roco-group', user_id: 'user', bot_user_id: 'bot', mentions: [{ user_id: 'bot' }] };
  const first = await service.handleMessage({ ...base, message_id: 'roco1', text: '喵喵的特性是什么' });
  assert.ok(first.messages.some(m => m.text?.includes('氧循环')));
  const second = await service.handleMessage({ ...base, message_id: 'roco2', text: '那它的技能呢' });
  assert.ok(second.messages.length);
  const gameCalls = calls.filter(c => c.options.usageSource === 'roco-game-knowledge');
  assert.equal(gameCalls.length, 2);
  assert.match(gameCalls[1].input, /技能石/);
  assert.ok(gameCalls[1].history.some(h => String(h.content).includes('氧循环')));
});
