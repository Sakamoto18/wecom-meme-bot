// Paid, read-only production-model evaluation. No QQ sends or persistent memory writes.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'dotenv';
import { nativeEnvironment } from './windows/environment.mjs';
import { RocoKnowledge, answerRocoQuestion } from '../src/roco-knowledge.js';
import { OpenAICompatibleChatClient } from '../src/chat-client.js';
import { LongtuWebSearch } from '../src/web-search.js';
import { QqPersonaStore } from '../src/qq-persona-store.js';

const args = process.argv.slice(2);
if (!args.includes('--live')) throw Error('Pass --live to allow model and web search calls (no QQ sends).');
const opt = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const root = opt('--config-root', 'C:/longtu-qq-bot');
const output = opt('--output', 'roco-topic-routing-eval.json');
const env = nativeEnvironment(root, parse(readFileSync(path.join(root, '.env.qq'))),
  parse(readFileSync(path.join(root, '.env.windows'))), process.env);
const client = new OpenAICompatibleChatClient({ apiKey: env.LLM_API_KEY, baseUrl: env.LLM_BASE_URL,
  model: env.LLM_MODEL, systemPrompt: readFileSync(path.resolve(root, env.LLM_SYSTEM_PROMPT_FILE || 'config/system-prompt.md'), 'utf8') });
const search = new LongtuWebSearch({ provider: env.WEB_SEARCH_PROVIDER,
  endpoint: env.WEB_SEARCH_ENDPOINT || env.LONGTU_WEB_SEARCH_ENDPOINT,
  exaApiKey: env.WEB_SEARCH_EXA_API_KEY || env.EXA_API_KEY,
  exaApiKeys: env.WEB_SEARCH_EXA_API_KEYS || env.EXA_API_KEYS,
  exaEndpoint: env.WEB_SEARCH_EXA_ENDPOINT, exaSearchType: env.WEB_SEARCH_EXA_TYPE,
  timeoutMs: Number(env.WEB_SEARCH_TIMEOUT_MS) || 6000,
  maxResults: Number(env.WEB_SEARCH_MAX_RESULTS) || 4,
  exaMaxContentCharacters: Number(env.WEB_SEARCH_EXA_MAX_CONTENT_CHARACTERS) || 1200,
});
const db = new DatabaseSync(path.join(root, 'data/qq-persona.sqlite'), { readOnly: true });
const row = db.prepare("SELECT version,profile_json FROM qq_persona_profiles WHERE scope_type='global' AND status='active' ORDER BY version DESC LIMIT 1").get();
db.close();
const formatter = new QqPersonaStore();
const profile = row ? { scopeType: 'global', scopeId: 'global', version: row.version, profile: JSON.parse(row.profile_json) } : null;
const personaContext = profile ? formatter.formatContext([profile]) : '';
const priorityPersonaContext = formatter.formatPriorityContext(profile);
const store = new RocoKnowledge({ databaseFilePath: path.resolve(root, env.QQ_ROCO_KNOWLEDGE_FILE || 'data/roco-world.sqlite') });
const history = [{ role: 'user', content: '当前发言人甲：寂灭骨龙的果实怎么获得' },
  { role: 'assistant', content: '可以通过对应的图鉴课题获得。' }];
const cases = [
  { id: 'topic_switch', query: '哈基米南北绿豆是什么梗', history, relevant: false },
  { id: 'unknown_with_game_history', query: '咕噜电波啥意思', history, relevant: false },
  { id: 'false_empty_route', query: '哈基米南北绿豆是什么梗', history, forced: true, mode: 'general-knowledge' },
  { id: 'false_matched_route', query: '哈基米南北绿豆是什么梗', history, forced: true, matched: true, mode: 'general-knowledge' },
  { id: 'known_game', query: '喵喵的特性是什么', relevant: true, mode: 'game-knowledge' },
  { id: 'explicit_unknown_game', query: '洛克王国世界阿巴阿巴兽在哪里抓', relevant: true, mode: 'game-knowledge' },
];
const report = { model: client.model, personaVersion: row?.version, cases: [] };
for (const c of cases.filter(c => !opt('--case', '') || c.id === opt('--case', ''))) {
  const calls = [], searches = [];
  const observed = { isConfigured: true, async complete(h, input, options) {
    const start = Date.now();
    const response = await client.complete(h, input, options);
    calls.push({ source: options.usageSource, ms: Date.now() - start, output: response });
    return response;
  } };
  const webSearch = { async search(q, options) {
    const found = await search.search(q, options);
    searches.push({ query: q, source: options.usageSource, results: found.results.map(r => ({ title: r.title, url: r.url })) });
    return found;
  } };
  let knowledge = await store.retrieve(c.query, { chatClient: observed, history: c.history || [] });
  if (c.forced) {
    // Deliberately inject a false-positive old route to exercise the escape path.
    const candidate = c.matched ? await store.retrieve('喵喵的特性是什么', { chatClient: observed }) : null;
    assert.ok(!c.matched || candidate?.records.length);
    knowledge = { metadata: store.metadata, records: candidate?.records || [], truncated: false,
      route: { question: '洛克王国世界哈基米南北绿豆是什么', searchQueries: ['洛克王国世界 哈基米南北绿豆'] } };
  }
  const answer = knowledge ? await answerRocoQuestion({ knowledge, query: c.query,
    history: c.history || [], chatClient: observed, webSearch, personaContext, priorityPersonaContext }) : null;
  const passed = (c.relevant === undefined || Boolean(knowledge) === c.relevant)
    && (!c.mode || answer?.mode === c.mode)
    && (!c.forced || (searches.length > 0 && searches.every(s => !s.query.includes('洛克'))));
  const result = { id: c.id, query: c.query, passed, ids: knowledge?.ids, answer, searches, calls };
  report.cases.push(result);
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ id: c.id, passed, answer, searches }));
}
if (report.cases.some(c => !c.passed)) process.exitCode = 1;
