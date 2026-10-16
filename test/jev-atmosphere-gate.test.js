import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JevAtmosphereGate, JevRuntimeState } from '../src/jev-atmosphere-gate.js';

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
    response_mode: { choice: 'banter', confidence: 0.9 },
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
  assert.ok(result.probability >= 0.72);
  assert.ok(calls[0].questions.should_speak);
  const style = await gate.evaluateStyle({ currentMessage: '评价一下这张图' });
  assert.equal(style.style.mode, 'banter');
  assert.equal(calls.length, 2);
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
