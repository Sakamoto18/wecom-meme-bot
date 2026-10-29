// Offline transport: calls the configured LLM, never QQ, memory ingestion or
// real search. Synthetic search evidence makes before/after runs comparable.
// Usage: node scripts/evaluate-persona-voice.mjs --live --root <code-root>
//        --config-root <deployment-root> --output <report.json>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'dotenv';

const args = process.argv.slice(2);
if (!args.includes('--live')) throw new Error('Requires --live: this evaluation uses paid model calls; it sends no QQ messages.');
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = path.resolve(option('--root', '.'));
const configRoot = path.resolve(option('--config-root', root));
const output = path.resolve(option('--output', 'persona-voice-eval.json'));
const overlay = path.join(configRoot, '.env.windows');
const env = { ...parse(readFileSync(path.join(configRoot, '.env.qq'))),
  ...(existsSync(overlay) ? parse(readFileSync(overlay)) : {}) };
const load = (file) => import(pathToFileURL(path.join(root, file)).href);
const { OpenAICompatibleChatClient } = await load('src/chat-client.js');
const { ReplyTurnPlanner } = await load('src/reply-turn-planner.js');
const { QqPersonaStore } = await load('src/qq-persona-store.js');
const { generateConversationReply } = await load('src/reply-engine.js');
const client = new OpenAICompatibleChatClient({
  apiKey: env.LLM_API_KEY, baseUrl: env.LLM_BASE_URL || 'https://api.deepseek.com',
  model: env.LLM_MODEL || 'deepseek-chat',
  systemPrompt: readFileSync(path.join(configRoot, 'config/system-prompt.md'), 'utf8'),
  temperature: 0.5,
});
const knowledgeContext = readFileSync(path.join(configRoot, 'config/longtu-knowledge.md'), 'utf8');
const db = new DatabaseSync(path.join(configRoot, 'data/qq-persona.sqlite'), { readOnly: true });
const row = db.prepare("SELECT version, profile_json FROM qq_persona_profiles WHERE scope_type='global' AND status='active' ORDER BY version DESC LIMIT 1").get();
db.close();
const formatter = new QqPersonaStore();
const persona = row ? { scopeType: 'global', scopeId: 'global', version: row.version, profile: JSON.parse(row.profile_json) } : null;
const personaContext = persona ? formatter.formatContext([persona]) : '';
const priorityPersonaContext = formatter.formatPriorityContext(persona);
const cases = [
  { id: 'friendly_banter', text: '今天又摸了一天鱼，我这工资拿得真有技术含量。', expect: '接自嘲，贴具体行为；不编造现实情况。' },
  { id: 'reasoning', text: '同一个链接缓存十分钟，那第九分钟改了内容，我会看到新的吗？', expect: '说明有效期内可能仍命中旧内容，刷新/失效后重取；短句。' },
  { id: 'current_facts', text: '红枫队最近怎么回事，胜场是放假了吗？',
    evidence: '【离线评测虚构事实】2026年10月29日赛果：红枫队10月24、26、28日三场全败，队长仍在队。2024年曾五连胜是旧成绩。',
    expect: '主动请求事实检索，使用本月三连败，不用2024旧战绩解释最近，不编队长离队。' },
  { id: 'quoted_speaker', text: '老王说“重启十次就能修好”，我听完都乐了。', expect: '笑点落在重复重启，不能误认提问者主张重启十次。' },
  { id: 'correction', text: '我说的是上传速度，不是下载。',
    history: [{ role: 'user', content: '为什么我传文件这么慢？' }, { role: 'assistant', content: '下载先看下行带宽。' }],
    interactionContext: { isCorrectionOfPreviousReply: true }, expect: '改答上行，别复读下载结论或自证认错过程。' },
  { id: 'stop_joking', text: '别开玩笑了，文件没保存就关掉了，怎么找回来？', expect: '停止攻击，给自动恢复/临时文件等合理建议或询问软件，不保证必能恢复。' },
  { id: 'topic_switch', text: '算了，晚饭吃啥？',
    history: [{ role: 'user', content: '缓存十分钟会怎样？' }, { role: 'assistant', content: '命中时会返回缓存，过期才重新抓。' }], expect: '跟上晚饭，不续讲缓存或检索不相干技术资料。' },
  { id: 'unknown_meme', text: '“月亮打卡报销”到底是哪来的梗？', expect: '检索无结果时承认出处没查到；可以解释可能的画面，不编固定梗、原作者和流行史。' },
];
const report = { model: client.model, personaVersion: row?.version, syntheticSearch: true, results: [] };
const selected = option('--cases', '').split(',').filter(Boolean);
for (const fixture of cases.filter((item) => !selected.length || selected.includes(item.id))) {
  const started = Date.now();
  const searches = [];
  const drafts = [];
  const planner = new ReplyTurnPlanner({ chatClient: client, timeoutMs: 30_000, maxTokens: 700, logger: { debug() {} } });
  try {
    const input = { content: fixture.text, currentQuestion: fixture.text, history: fixture.history ?? [], now: Date.parse('2026-10-29T12:00:00+08:00'), interactionContext: fixture.interactionContext ?? {} };
    const turnPlan = await planner.plan(input);
    const result = await generateConversationReply({
      ...input, modelInput: fixture.text, turnPlan, personaContext, priorityPersonaContext, knowledgeContext,
      groupStyleProvider: () => '【本群真实语感参考】喜欢贴当前动作顺杆爬、假夸；多短句，不习惯给别人上课。',
      memeCorpus: { buildPrompt: () => '【外部语料表达参考】只借节奏和反差，不作事实：忙活半天，进度条先睡了。' },
      webSearchEnabled: true,
      webSearch: { async search(query, options) {
        searches.push({ query, mode: options?.mode });
        return { context: fixture.evidence || '', resultCount: fixture.evidence ? 1 : 0 };
      } },
      chatClient: { isConfigured: client.isConfigured, async complete(history, content, options) {
        const answer = await client.complete(history, content, options);
        drafts.push({ stage: options.usageSource, answer,
          groupStylePresent: Boolean(options.additionalSystemPrompt?.includes('【本群真实语感参考】')),
          corpusPresent: Boolean(options.additionalSystemPrompt?.includes('【外部语料表达参考】')) });
        return answer;
      } },
    });
    report.results.push({ id: fixture.id, input: fixture.text, expect: fixture.expect, plan: turnPlan,
      searches, drafts, answer: result.answer, review: result.review,
      thinking: result.thinkingEnabled, rewritten: result.rewriteUsed,
      factSearch: result.factSearchAttempted, cultureSearch: result.cultureSearchAttempted,
      characters: result.answer.length, elapsedMs: Date.now() - started });
  } catch (error) {
    // Do not print provider error bodies; they can contain request metadata.
    report.results.push({ id: fixture.id, failed: true, errorType: error.name, elapsedMs: Date.now() - started });
  }
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ completed: fixture.id, failed: Boolean(report.results.at(-1).failed) }));
}
if (report.results.some((result) => result.failed)) process.exitCode = 1;
