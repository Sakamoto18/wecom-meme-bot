import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  JevAtmosphereGate,
  JevRuntimeState,
  buildJevSemanticPrompt,
  buildJevStylePrompt,
} from '../src/jev-atmosphere-gate.js';
import {
  JevResponseModeMemory,
  resolveJevResponseMode,
} from '../src/jev-response-mode.js';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function answers(overrides = {}) {
  return {
    should_speak: { noul: 0.9 },
    adds_value: { noul: 0.9 },
    would_interrupt: { noul: 0.1 },
    meme_fit: { noul: 0.8 },
    explanation_needed: { noul: 0.1 },
    culture_lookup_needed: { noul: 0.2 },
    culture_domain: { choice: 'longtu', confidence: 0.9 },
    longtu_lookup_needed: { noul: 0.8 },
    platform: { choice: 'tieba' },
    tone: { choice: 'absurd' },
    target: { choice: 'content' },
    response_mode: { choice: 'banter', confidence: 0.9 },
    context_image_needed: { noul: 0 },
    context_image_indexes: [],
    context_image_reason: '',
    image_culture_needed: { noul: 0 },
    image_fact_check_needed: { noul: 0 },
    image_complete_read_needed: { noul: 0 },
    image_query_terms: [],
    ...overrides,
  };
}

test('Jev 关闭或未配置时无痛回退', async () => {
  const gate = new JevAtmosphereGate({ apiKey: '', runtime: new JevRuntimeState({ defaultMode: 'off' }) });
  const result = await gate.evaluate({ currentMessage: 'hello' });
  assert.equal(result.decision, 'fallback');
  assert.equal(result.reason, 'jev-unconfigured');
});

test('Jev 解析插话概率和风格路由', async () => {
  const runtime = new JevRuntimeState({ defaultMode: 'on' });
  const calls = [];
  const gate = new JevAtmosphereGate({
    apiKey: 'test',
    runtime,
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return response({ answers: answers() });
    },
  });
  const result = await gate.evaluate({ currentMessage: '这个梗还能接吗' });
  assert.equal(result.decision, 'allow');
  assert.equal(result.style.mode, 'banter');
  assert.equal(result.style.cultureDomain, 'longtu');
  assert.equal(result.style.platform, 'tieba');
  assert.equal(result.style.longtuLookupNeeded, 0.8);
  assert.ok(result.style.longtuTerms.includes('龙图'));
  assert.ok(result.probability >= 0.72);
  assert.ok(calls[0].questions.should_speak);
  const style = await gate.evaluateStyle({ currentMessage: '评价一下这张图' });
  assert.equal(style.style.mode, 'banter');
  assert.equal(style.style.cultureDomain, 'longtu');
  assert.equal(calls.length, 2);
});

test('Jev 只从有编号的历史图片候选中选择必要图片', async () => {
  const runtime = new JevRuntimeState({ defaultMode: 'on' });
  let request;
  const gate = new JevAtmosphereGate({
    apiKey: 'test',
    protocol: 'chat',
    runtime,
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return response({ choices: [{ message: { content: JSON.stringify(answers({
        context_image_needed: 0.92,
        context_image_indexes: [2, 99, 2],
        context_image_reason: '当前消息承接第二张截图',
        image_culture_needed: 0.88,
        image_fact_check_needed: 0.76,
        image_complete_read_needed: 0.93,
        image_query_terms: ['亡灵骑士'],
      })) } }] });
    },
  });
  const result = await gate.evaluateStyle({
    currentMessage: '刚才第二张截图里的那句话是什么意思',
    contextImageCandidates: [
      { index: 1, sender: '甲', label: '图片', summary: '旧图', hasRawImage: true },
      { index: 2, sender: '乙', label: '截图', summary: '聊天记录', hasRawImage: true },
    ],
  });
  assert.equal(result.style.contextImageNeeded, 0.92);
  assert.deepEqual(result.style.contextImageIndexes, [2]);
  assert.equal(result.style.imageCultureNeeded, 0.88);
  assert.equal(result.style.imageFactCheckNeeded, 0.76);
  assert.equal(result.style.imageCompleteReadingNeeded, 0.93);
  assert.deepEqual(result.style.imageQueryTerms, ['亡灵骑士']);
  assert.deepEqual(request.messages[1].content.includes('context_images'), true);
  assert.deepEqual(JSON.parse(request.messages[1].content.split('\n')[1]).state.context_images.length, 2);
});

test('百炼 Chat 模式只做插话和文化检索路由，不改写角色提示', async () => {
  const runtime = new JevRuntimeState({ defaultMode: 'on' });
  const calls = [];
  const gate = new JevAtmosphereGate({
    apiKey: 'test',
    protocol: 'chat',
    model: 'qwen3.8-flash',
    runtime,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response({
        model: 'qwen3.8-flash',
        usage: { prompt_tokens: 120, completion_tokens: 35, total_tokens: 155 },
        choices: [{ message: { content: JSON.stringify({
          should_speak: 0.92,
          adds_value: 0.88,
          would_interrupt: 0.08,
          meme_fit: 0.75,
          explanation_needed: 0.2,
          culture_lookup_needed: 0.9,
          culture_domain: 'general',
          longtu_lookup_needed: 0.1,
          platform: 'tieba',
          tone: 'absurd',
          target: 'content',
          response_mode: 'banter',
          query_terms: ['亡灵骑士'],
          longtu_terms: [],
        }) } }],
      });
    },
  });

  const decision = await gate.evaluate({ currentMessage: '这个梗需要查一下出处吗' });
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.style.promptEnabled, true);
  assert.equal(decision.style.cultureDomain, 'general');
  assert.deepEqual(decision.style.queryTerms, ['亡灵骑士']);
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/chat/completions');
  assert.equal(calls[0].body.model, 'qwen3.8-flash');

  const routed = await gate.evaluateStyle({ currentMessage: '评价这个网络梗' });
  assert.equal(routed.decision, 'allow');
  assert.equal(routed.style.promptEnabled, true);
  assert.equal(routed.style.cultureLookupNeeded, 0.9);
  assert.equal(calls.length, 2);
});

test('Jev 文化优先模式覆盖非严肃问题，明确正经追问保留正经路由', () => {
  const culture = resolveJevResponseMode({
    mode: 'concise_answer',
    memeFit: 0.82,
    culturePriority: 0.91,
    seriousRequest: 0.12,
  }, null, { cultureDefault: true });
  assert.equal(culture.mode, 'culture');

  const serious = resolveJevResponseMode({
    mode: 'explanation',
    memeFit: 0.8,
    explanationNeeded: 0.9,
    seriousRequest: 0.93,
  }, null, { cultureDefault: true });
  assert.equal(serious.mode, 'serious');
});

test('Jev 文化模式在正经追问后维持两轮并自动回落', () => {
  let now = 1_000;
  const memory = new JevResponseModeMemory({ now: () => now, ttlTurns: 2 });
  const first = memory.resolve('group:1', { mode: 'banter', memeFit: 0.9 }, { cultureDefault: true }).style;
  memory.commit('group:1', first);
  assert.equal(memory.get('group:1').mode, 'culture');

  const serious = memory.resolve('group:1', {
    mode: 'explanation',
    explanationNeeded: 0.95,
    seriousRequest: 0.95,
  }, { cultureDefault: true }).style;
  assert.equal(serious.mode, 'serious');
  memory.commit('group:1', serious);
  assert.equal(memory.get('group:1').remainingTurns, 1);

  now += 100;
  const followup = memory.resolve('group:1', { mode: 'concise_answer', memeFit: 0.1 }, { cultureDefault: true }).style;
  assert.equal(followup.mode, 'serious');
  memory.commit('group:1', followup);
  const restored = memory.resolve('group:1', { mode: 'concise_answer', memeFit: 0.1 }, { cultureDefault: true }).style;
  assert.equal(restored.mode, 'culture');
});

test('Chat Jev 的文化路由会把质量模板传给最终回复层', () => {
  const prompt = buildJevStylePrompt({
    promptEnabled: true,
    mode: 'culture',
    culturePriority: 0.9,
    concreteAssociation: 0.88,
    literalReplyRisk: 0.8,
  });
  assert.match(prompt, /文化输出质量校准/);
  assert.match(prompt, /具体关系/);
  assert.match(prompt, /不要先复述图片/);
});

test('Jev 结构化输出图片语用候选，并在高价值场景读取原图', async () => {
  const runtime = new JevRuntimeState({ defaultMode: 'on' });
  let request;
  const gate = new JevAtmosphereGate({
    apiKey: 'test',
    protocol: 'chat',
    runtime,
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return response({
        choices: [{ message: { content: JSON.stringify(answers({
          semantic_relation: '遮挡字形把正经词变成了悼词，画面借此制造反差',
          semantic_point: '表面在说尊重，视觉上却已经把气氛送走了',
          comic_mechanism: '拆字+黑白幻视',
          stance: 'absurd',
          literal_only_risk: 0.91,
          unknown_concept: true,
          semantic_confidence: 0.84,
          candidate_associations: [{
            idea: '把这场景接成葬礼现场的错位播报',
            why_fit: '正经字面和视觉变体形成反差',
            risk: '原图字形不清时不要硬套',
          }],
          semantic_avoid_literal: ['只说画面是黑白的', '逐字复述标题'],
        })) } }],
      });
    },
  });
  const style = await gate.evaluateStyle({
    currentMessage: '这图到底什么梗',
    rawImageForJev: true,
    rawImageBlocks: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
  });
  assert.equal(request.messages[1].content[1].type, 'image_url');
  assert.equal(style.style.semanticPoint.includes('气氛'), true);
  assert.equal(style.style.semanticRelation.includes('遮挡字形'), true);
  assert.equal(style.style.associationCandidates.length, 1);
  assert.equal(style.style.literalOnlyRisk, 0.91);
  assert.match(buildJevSemanticPrompt(style.style), /图片表达重点/);
  assert.match(buildJevSemanticPrompt(style.style), /葬礼现场/);
  assert.match(buildJevSemanticPrompt(style.style), /不要只重复/);
});

test('Jev 回调包含真实模型、Token、来源和延迟', async () => {
  const runtime = new JevRuntimeState({ defaultMode: 'on' });
  const events = [];
  const gate = new JevAtmosphereGate({
    apiKey: 'test',
    runtime,
    onUsage: (event) => events.push(event),
    fetchImpl: async () => response({
      model: 'jev-1.14.0',
      usage: { input_tokens: 123, output_tokens: 17 },
      answers: answers(),
    }),
  });
  await gate.evaluate({ currentMessage: 'test' });
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'jev-atmosphere');
  assert.equal(events[0].model, 'jev-1.14.0');
  assert.deepEqual(events[0].usage, { input_tokens: 123, output_tokens: 17 });
  assert.equal(events[0].succeeded, true);
  assert.equal(events[0].status, 200);
  assert.equal(typeof events[0].latencyMs, 'number');
});

test('Jev 低概率返回 skip，高概率阈值可配置', async () => {
  const runtime = new JevRuntimeState({ defaultMode: 'on' });
  const gate = new JevAtmosphereGate({
    apiKey: 'test',
    runtime,
    fetchImpl: async () => response({ answers: answers({
      should_speak: { noul: 0.1 },
      adds_value: { noul: 0.2 },
      would_interrupt: { noul: 0.9 },
    }) }),
  });
  const result = await gate.evaluate({ currentMessage: '哈哈' });
  assert.equal(result.decision, 'skip');
  assert.ok(result.probability <= 0.28);
});

test('Jev 额度错误自动熔断并持久化状态', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jev-gate-'));
  const filePath = path.join(directory, 'runtime.json');
  try {
    const runtime = new JevRuntimeState({ filePath, defaultMode: 'on' });
    const gate = new JevAtmosphereGate({
      apiKey: 'test',
      runtime,
      fetchImpl: async () => response({ error: { message: 'quota exceeded' } }, 429),
    });
    const result = await gate.evaluate({ currentMessage: 'test' });
    assert.equal(result.decision, 'fallback');
    assert.equal(runtime.status().effectiveMode, 'fallback');
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(persisted.mode, 'on');
    assert.ok(persisted.circuitOpenUntil > Date.now());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Jev 瞬时上游错误不会三次就熔断整小时', async () => {
  const runtime = new JevRuntimeState({
    defaultMode: 'on',
    failureThreshold: 6,
    cooldownMs: 300_000,
  });
  const gate = new JevAtmosphereGate({
    apiKey: 'test',
    runtime,
    fetchImpl: async () => response({ error: { message: 'upstream timeout' } }, 500),
  });
  await gate.evaluate({ currentMessage: 'test' });
  await gate.evaluate({ currentMessage: 'test' });
  await gate.evaluate({ currentMessage: 'test' });
  assert.equal(runtime.status().circuitOpen, false);
  assert.equal(runtime.status().failureCount, 3);
});

test('Jev HTTP 失败也记录失败用量事件所需元数据', async () => {
  const runtime = new JevRuntimeState({ defaultMode: 'on' });
  const events = [];
  const gate = new JevAtmosphereGate({
    apiKey: 'test',
    runtime,
    onUsage: (event) => events.push(event),
    fetchImpl: async () => response({ error: { message: 'bad request' } }, 400),
  });
  const result = await gate.evaluate({ currentMessage: 'test' });
  assert.equal(result.decision, 'fallback');
  assert.equal(events.length, 1);
  assert.equal(events[0].succeeded, false);
  assert.equal(events[0].status, 400);
  assert.match(events[0].error, /Jev 请求失败/);
});
