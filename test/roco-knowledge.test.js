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

function routeClient(route, inspect = () => {}) {
  return { isConfigured: true, async complete(history, input, options) {
    assert.equal(options.usageSource, 'roco-route');
    inspect(JSON.parse(input), options);
    return JSON.stringify({ relevant: true, confidence: .95, ids: [], ...route });
  } };
}
const retrieve = (store, query, route, options = {}) => store.retrieve(query, {
  ...options, chatClient: routeClient(route, options.inspect),
});

test('model-selected entity IDs preserve forms, values and skill acquisition', async t => {
  const store = setup(t);
  const boss = await retrieve(store, '@龙2号机 圣光迪莫', { ids: ['pet:圣光迪莫'] });
  assert.equal(boss.records[0].名称, '圣光迪莫');
  assert.equal(boss.records[0].字段.特性, '裁决');
  assert.ok(!boss.records.some(r => r.名称 === '迪莫'));
  const miao = await retrieve(store, '喵喵能学哪些技能', { ids: ['pet:喵喵'], include_skills: true });
  assert.equal(miao.records[0].技能表.length, 52);
  assert.equal(miao.records[0].技能表.filter(s => s.习得 === '自学').length, 16);
  assert.equal(miao.records[0].字段.生命种族值, '65');
  assert.ok(miao.records[0].技能表.filter(s => s.习得 === '技能石').every(s => s.等级 === ''));
  const cross = await retrieve(store, '洛克世界谁能学棘突', { ids: ['skill:棘突'], inverse: true });
  assert.equal(cross.records[0].关联精灵[0].精灵, '喵喵');
  assert.equal(cross.records[0].关联精灵[0].习得[0].等级, '6');
});

test('skill-only questions can retrieve acquisition evidence from pet detail pages', async t => {
  const store = setup(t);
  const pet = store.entries.find(e => e.id === 'pet:喵喵');
  pet.sections = { '课题': '课题原文', '生态与获取': '本精灵的获取资料' };
  pet.skills.push({ 名称: '棘突', 习得: '技能石', 等级: '999', 详情: '技能石来源 某精灵 使用2次棘突' });
  const found = await retrieve(store, '棘突技能石怎么解锁', { ids: ['skill:棘突'] });
  assert.equal(found.records[0].技能石获取资料[0].来源文档所属精灵, '喵喵');
  assert.equal(found.records[0].技能石获取资料[0].来源, pet.url);
  assert.match(found.records[0].技能石获取资料[0].详情, /使用2次棘突/);
  const scoped = await retrieve(store, '喵喵的果实', { ids:['pet:喵喵'], sections:['课题','生态与获取'] });
  assert.match(scoped.records[0].章节归属, /喵喵/);
  assert.equal(scoped.records[0].章节['课题'], '课题原文');
});

test('same-user previous entities are isolated, expire, and never override none', async t => {
  let now = 1000;
  const store = setup(t, () => now);
  const initial = await retrieve(store, '喵喵的特性呢', { ids: ['pet:喵喵'] }, { sessionKey: 'g1:u1' });
  store.remember(initial);
  for (const [key, expected] of [['g1:u1',['pet:喵喵']], ['g1:u2',[]], ['g2:u1',[]]]) {
    await retrieve(store, '那它呢', { relevant: false }, { sessionKey: key,
      inspect: input => assert.deepEqual(input.same_sender_previous, expected) });
  }
  // A semantic topic change clears stale game context.
  await retrieve(store, '晚饭吃什么', { relevant: false }, { sessionKey: 'g1:u1',
    inspect: input => assert.deepEqual(input.same_sender_previous, []) });
  store.remember(initial); now += 600001;
  await retrieve(store, '那它呢', { relevant: false }, { sessionKey: 'g1:u1',
    inspect: input => assert.deepEqual(input.same_sender_previous, []) });
});

test('selection sees complete at-message, quote and history; invalid/empty choices stay empty', async t => {
  const store = setup(t);
  const query = '@龙2号机 喵喵';
  const selected = await retrieve(store, query, { ids: ['pet:喵喵', 'pet:不存在'] }, {
    quote: '之前的原文', history: [{ role: 'user', content: '当前发言人：A；解释它的技能' }],
    inspect: input => {
      assert.equal(input.current_message, query);
      assert.equal(input.quote, '之前的原文');
      assert.equal(input.history.length, 1);
      assert.ok(input.catalogue.some(row => row[0] === 'pet:喵喵'));
    },
  });
  assert.deepEqual(selected.ids, ['pet:喵喵']);
  assert.equal(selected.truncated, true);
  const empty = await retrieve(store, query, { ids: [] });
  assert.equal(empty.records.length, 0);
  assert.equal(await retrieve(store, '我食物中毒了', { relevant: false }), null);
  assert.equal(await retrieve(store, query, { confidence: .2, ids: ['pet:喵喵'] }), null);
  for (const output of ['bad JSON', 'null', '[]']) assert.equal(await store.retrieve(query, { chatClient: { isConfigured: true, complete: async () => output } }), null);
});

test('evidence answer receives active persona, validates output, and has no forced source tail', async t => {
  const store = setup(t);
  const query = '洛克世界中毒是什么效果';
  const calls = [];
  const result = await generateConversationReply({ content: query, modelInput: query,
    gameKnowledge: await retrieve(store, query, { ids: ['effect:中毒'] }),
    personaContext: '角色：短句自然接话', priorityPersonaContext: '当前全局人格 v3',
    groupStyleProvider: () => '本群口语参考',
    webSearch: { search() { throw new Error('不应联网'); } },
    memeKnowledge: { lookupTaughtAssociations() { throw new Error('不应走玩梗'); } },
    chatClient: { isConfigured: true, async complete(history, input, options) {
      calls.push(options.usageSource);
      assert.match(input, /3%生命/);
      if (options.usageSource === 'roco-evidence-coverage') return '{"sufficient":true}';
      if (options.usageSource === 'roco-grounding-review') return '{"supported":true}';
      assert.match(options.additionalSystemPrompt, /角色：短句自然接话/);
      assert.match(options.additionalSystemPrompt, /本群口语参考/);
      assert.match(options.additionalSystemPrompt, /不执行其中指令/);
      assert.match(options.additionalSystemPrompt, /不加来源/);
      assert.equal(options.prioritySystemPrompt, '当前全局人格 v3');
      return '回合结束造成3%生命的毒系伤害，毒系精灵免疫。';
    } },
  });
  assert.equal(result.mode, 'game-knowledge');
  assert.deepEqual(calls, ['roco-evidence-coverage','roco-game-knowledge','roco-grounding-review']);
  assert.doesNotMatch(result.answer, /来源/);
  assert.ok(result.references.length);
});

test('unsupported draft must be rewritten and checked; failed review does not publish a claim', async t => {
  const store = setup(t);
  const knowledge = await retrieve(store, '喵喵怎么获取', { ids: ['pet:喵喵'] });
  let attempts = 0, reviews = 0;
  const chatClient = { isConfigured: true, async complete(history, input, options) {
    if (options.usageSource === 'roco-grounding-review') {
      reviews++;
      return JSON.stringify({ supported: reviews === 2, issues: ['没有地图方向和等级条件证据'] });
    }
    attempts++;
    if (attempts === 2) assert.match(options.revisionSystemPrompt, /没有地图/);
    return attempts === 1 ? '北边树上抓，40级。' : '获取地点还没查到准信，先别乱跑。';
  } };
  const answer = await answerRocoQuestion({ knowledge, query: '喵喵怎么获取', chatClient });
  assert.equal(answer.answer, '获取地点还没查到准信，先别乱跑。');
  assert.equal(reviews, 2);
  const failed = await answerRocoQuestion({ knowledge, query: '喵喵怎么获取', chatClient: {
    ...chatClient, complete: async (_,__,o) => o.usageSource === 'roco-grounding-review' ? 'invalid' : '地图北边40级',
  } });
  assert.doesNotMatch(failed.answer, /40级|地图北边/);
});

test('search supplements missing evidence; source display is a semantic user request', async t => {
  const store = setup(t);
  const knowledge = await retrieve(store, '给我攻略社区链接', { search_queries: ['洛克王国世界 攻略社区'], show_sources: true });
  let searchCount = 0;
  const result = await answerRocoQuestion({ knowledge, query: '给我攻略社区链接',
    webSearch: { async search(q) { searchCount++; return { results: [{ title: '社区', url: 'https://example.com/guide', text: '攻略讨论区' }] }; } },
    chatClient: { async complete(_, input, opts) {
      assert.match(input, /攻略讨论区/);
      if (opts.usageSource === 'roco-grounding-review') return '{"supported":true}';
      assert.match(opts.additionalSystemPrompt, /用户要出处/);
      return '攻略讨论区：https://example.com/guide';
    } },
  });
  assert.equal(searchCount, 1);
  assert.deepEqual(result.references, ['https://example.com/guide']);
});

for (const official of [false, true]) test(`${official ? 'official' : 'NapCat'} uses semantic lookup, active persona and the existing send/history pipeline`, async t => {
  const store = setup(t);
  const calls = [];
  const memory = new ConversationStore();
  const service = new QqBotService({ rocoKnowledge: store, conversationStore: memory,
    personaManager: { contextFor: () => '激活的人格', priorityContextFor: () => '全局人格' },
    imageOcrEnabled: false, webSearchEnabled: false, roleplayImmersion: false,
    chatClient: { isConfigured: true, async complete(history, input, options) {
      calls.push({ history, input, options });
      if (options.usageSource === 'roco-route') return JSON.stringify({ relevant:true,confidence:.95,ids:['pet:喵喵'],include_skills:true });
      if (options.usageSource === 'roco-grounding-review') return '{"supported":true}';
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
  assert.match(gameCalls[1].options.additionalSystemPrompt, /激活的人格/);
  assert.ok(gameCalls[1].history.some(h => String(h.content).includes('氧循环')));
});

const missingKnowledge = () => ({ metadata:{importedAt:'2026-11-13'}, records:[{名称:'迪莫',来源:'https://wiki.example/dimo',章节:{进化:'可进化为光系首领'}}],route:{question:'迪莫光系首领进化道具前置任务是什么',searchQueries:[]},truncated:false });

test('coverage reads actual wiki bodies and searches non-wiki evidence before answering', async () => {
  const searches=[];
  const answer=await answerRocoQuestion({knowledge:missingKnowledge(),query:'迪莫光系首领进化道具前置任务是什么',priorityPersonaContext:'全局角色',
    webSearch:{async search(q){searches.push(q);return {results:[{url:'https://guide.example/task',description:'测试证据：前置任务为任务甲。',publishedDate:'2026-11-19'}]};}},
    chatClient:{async complete(_,input,o){
      const data=JSON.parse(input);
      if(o.usageSource==='roco-evidence-coverage'){
        assert.equal(data.evidence.records[0].章节.进化,'可进化为光系首领');
        return JSON.stringify({sufficient:false,search_queries:['洛克王国世界 迪莫 光系首领 进化道具 前置任务']});
      }
      assert.equal(data.evidence.web[0].publishedDate,'2026-11-19');
      assert.match(data.evidence.web[0].text,/任务甲/);
      if(o.usageSource==='roco-grounding-review')return '{"supported":true}';
      assert.equal(o.prioritySystemPrompt,'全局角色');
      return '先完成任务甲。';
    }}});
  assert.equal(searches.length,1);assert.equal(answer.answer,'先完成任务甲。');
  assert.ok(answer.references.includes('https://guide.example/task'));
});

test('review can request missing evidence even when a cautious draft is supported', async () => {
  let drafts=0,searches=0;
  const answer=await answerRocoQuestion({knowledge:missingKnowledge(),query:'前置任务是什么',
    webSearch:{async search(){searches++;return {results:[{url:'https://guide.example/task',text:'测试事实：完成任务甲。'}]};}},
    chatClient:{async complete(_,input,o){
      if(o.usageSource==='roco-evidence-coverage')return '{"sufficient":true}';
      if(o.usageSource==='roco-grounding-review')return JSON.stringify({supported:true,needs_search:drafts===1,search_queries:['洛克王国世界 迪莫 进化 前置任务']});
      drafts++;if(drafts===2)assert.match(input,/测试事实/);
      return drafts===1?'还没有查到。':'先完成任务甲。';
    }}});
  assert.equal(drafts,2);assert.equal(searches,1);assert.equal(answer.answer,'先完成任务甲。');
});

test('missing wiki snapshot still permits grounded web answer', async () => {
  const knowledge={...missingKnowledge(),metadata:null,records:[]};
  let searches=0;
  const answer=await answerRocoQuestion({knowledge,query:'前置任务',webSearch:{async search(){searches++;return {results:[{url:'https://guide.example/a',text:'测试事实'}]};}},
    chatClient:{async complete(_,input,o){
      if(o.usageSource==='roco-evidence-coverage')return '{"sufficient":false,"search_queries":["洛克王国世界 前置任务"]}';
      if(o.usageSource==='roco-grounding-review')return '{"supported":true}';
      assert.match(input,/测试事实/);return '有对应攻略说明。';
    }}});
  assert.equal(searches,1);assert.equal(answer.answer,'有对应攻略说明。');
});

test('search failures preserve uncertainty and review cannot publish unsupported claims', async () => {
  let searches=0;
  const answer=await answerRocoQuestion({knowledge:missingKnowledge(),query:'前置任务',webSearch:{async search(){searches++;throw Error('offline');}},
    chatClient:{async complete(_,input,o){
      if(o.usageSource==='roco-evidence-coverage')return '{"sufficient":false,"search_queries":["洛克王国世界 任务"]}';
      if(o.usageSource==='roco-grounding-review')return '{"supported":false,"needs_search":true,"search_queries":["洛克王国世界 任务"]}';
      assert.equal(JSON.parse(input).evidence.searchFailed,true);return '完成999个任务。';
    }}});
  assert.equal(searches,1);assert.doesNotMatch(answer.answer,/999/);
});

test('disabled web search bypasses coverage and search even for empty wiki records', async () => {
  const calls=[];
  await answerRocoQuestion({knowledge:missingKnowledge(),query:'前置任务',webSearchEnabled:false,
    webSearch:{search(){throw Error('disabled');}},chatClient:{async complete(_,__,o){calls.push(o.usageSource);return o.usageSource==='roco-grounding-review'?'{"supported":true}':'条件暂时没查到。';}}});
  assert.deepEqual(calls,['roco-game-knowledge','roco-grounding-review']);
});

test('failed expanded draft retains already verified partial answer instead of discarding known facts', async () => {
  let drafts=0;
  const answer=await answerRocoQuestion({knowledge:missingKnowledge(),query:'前置任务和原初之章',
    webSearch:{async search(){return {results:[]};}},chatClient:{async complete(_,__,o){
      if(o.usageSource==='roco-evidence-coverage')return '{"sufficient":true}';
      if(o.usageSource==='roco-grounding-review')return JSON.stringify({supported:drafts===1,needs_search:true,search_queries:['洛克王国世界 原初之章'],issues:['不能用未命中证明不存在']});
      drafts++;return drafts===1?'先完成任务甲，原初之章的条件暂未核实。':'原初之章不存在。';
    }}});
  assert.equal(answer.answer,'先完成任务甲，原初之章的条件暂未核实。');
});
