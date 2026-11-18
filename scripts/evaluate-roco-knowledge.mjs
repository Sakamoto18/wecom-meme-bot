// Real model evaluation, read-only persona/snapshot, no QQ messages or memory writes.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'dotenv';
import { RocoKnowledge, answerRocoQuestion } from '../src/roco-knowledge.js';
import { OpenAICompatibleChatClient } from '../src/chat-client.js';
import { QqPersonaStore } from '../src/qq-persona-store.js';

const args = process.argv.slice(2);
if (!args.includes('--live')) throw new Error('Use --live for paid model calls (no QQ sends).');
const opt = (key, value) => args.includes(key) ? args[args.indexOf(key)+1] : value;
const configRoot = opt('--config-root', 'C:/longtu-qq-bot');
const output = opt('--output', 'roco-eval.json');
const env = { ...parse(readFileSync(path.join(configRoot,'.env.qq'))),
  ...parse(readFileSync(path.join(configRoot,'.env.windows'))) };
const client = new OpenAICompatibleChatClient({ apiKey:env.LLM_API_KEY,baseUrl:env.LLM_BASE_URL,
  model:env.LLM_MODEL,systemPrompt:readFileSync(path.join(configRoot,'config/system-prompt.md'),'utf8') });
const db = new DatabaseSync(path.join(configRoot,'data/qq-persona.sqlite'), {readOnly:true});
const row = db.prepare("SELECT version,profile_json FROM qq_persona_profiles WHERE scope_type='global' AND status='active' ORDER BY version DESC LIMIT 1").get();
db.close();
const formatter = new QqPersonaStore();
const profile = row ? {scopeType:'global',scopeId:'global',version:row.version,profile:JSON.parse(row.profile_json)} : null;
const personaContext = profile ? formatter.formatContext([profile]) : '';
const priorityPersonaContext = formatter.formatPriorityContext(profile);
const store = new RocoKnowledge({ databaseFilePath: opt('--snapshot', path.join(configRoot,'data/roco-world.sqlite')) });
const cases = [
  {id:'water',query:'@龙2号机 那我问你水蓝蓝要带润泽，怎么解锁润泽'},
  {id:'name',query:'@龙2号机 寂灭骨龙'},
  {id:'typo',query:'@龙2号机 寂灭古龙在哪里抓'},
  {id:'fruit',query:'寂灭骨龙的果实怎么获得'},
  {id:'correction',query:'寂灭骨龙的果实是抓20只骨龙的图鉴任务',history:[{role:'assistant',content:'摘智慧树果实就行。'}]},
  {id:'source',query:'润泽技能石怎么解锁，给原文链接'},
  {id:'followup',query:'那它几级进化',previous:'pet:大头骨龙'},
  {id:'false_claim',query:'水蓝蓝的润泽是不是15级自学？'},
  {id:'unknown',query:'洛克世界阿巴阿巴兽在哪里抓'},
  {id:'ordinary',query:'我好像食物中毒了，怎么办'},
  {id:'topic_change',query:'那今天中午吃什么',previous:'pet:寂灭骨龙'},
];
const report={model:client.model,personaVersion:row?.version,cases:[]};
const selected=opt('--case','');
for(const c of cases.filter(c=>!selected||c.id===selected)){
 const calls=[];
 const observed={isConfigured:true,async complete(history,input,options){
   const start=Date.now();const answer=await client.complete(history,input,options);
   calls.push({source:options.usageSource,ms:Date.now()-start,...(['roco-route','roco-grounding-review','roco-game-knowledge'].includes(options.usageSource)?{output:answer}:{})});return answer;
 }};
 const sessionKey='eval:'+c.id;
 if(c.previous)store.remember({sessionKey,ids:[c.previous]});
 const knowledge=await store.retrieve(c.query,{sessionKey,chatClient:observed,history:c.history||[]});
 const answer=knowledge ? await answerRocoQuestion({knowledge,chatClient:observed,query:c.query,history:c.history||[],personaContext,priorityPersonaContext,webSearchEnabled:false}) : null;
 report.cases.push({id:c.id,query:c.query,ids:knowledge?.ids,route:knowledge?.route,answer:answer?.answer,calls});
 writeFileSync(output,JSON.stringify(report,null,2));
 console.log(JSON.stringify({id:c.id,ids:knowledge?.ids,route:knowledge?.route,answer:answer?.answer}));
}
