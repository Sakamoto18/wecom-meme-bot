import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Jimp } from 'jimp';
import { LongtuLibrary } from '../src/longtu-library.js';
import { LongtuSemanticIndex } from '../src/longtu-semantic.js';

async function fixture(t, complete, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'longtu-semantic-'));
  const library = new LongtuLibrary({ databaseFilePath: path.join(root, 'library.sqlite'), assetsDirectory: path.join(root, 'assets'), ocrCommand: '' });
  await library.load();
  t.after(async () => { library.close(); await rm(root, { recursive: true, force: true }); });
  const candidates = [];
  for (let i = 0; i < 2; i += 1) {
    const buffer = await new Jimp({ width: 32, height: 32, color: i ? 0xff0000ff : 0x00ff00ff }).getBuffer('image/png');
    const file = path.join(root, `${i}.png`);
    await writeFile(file, buffer);
    candidates.push({ path: file, extension: '.png', sha256: createHash('sha256').update(buffer).digest('hex') });
  }
  const groups = [{ id: '无语', inputTerms: ['无语', '无话可说'], poolTerms: ['无语'] }];
  const index = new LongtuSemanticIndex({ library, memeStore: { getLongtuCandidates: async () => candidates },
    chatClient: { isConfigured: true, complete }, getRelations: () => groups,
    logger: { warn() {} }, ...options });
  return { library, index, candidates, groups };
}

test('自动索引视觉文字与场景、关联词族，重启后复用；不覆盖人工标记', async t => {
  let calls = 0;
  const { library, index, candidates } = await fixture(t, async (_history, input, opts) => {
    calls += 1;
    assert.equal(opts.usageSource, 'longtu-semantic-index');
    assert.equal(input[1].type, 'image_url');
    return JSON.stringify({ description: '无语地望天', visibleText: ['我还能说什么'], scenes: ['对荒唐事情无言以对'],
      keywords: ['无奈'], familyIds: ['无语', '不存在'], confidence: 'high' });
  });
  library.bindAlias('保留手动标签', candidates[0].sha256);
  await index.tick();
  assert.equal(calls, 1);
  library.close();
  await library.load();
  const stored = library.getImageSemantics(candidates[0].sha256);
  assert.deepEqual(stored.familyIds, ['无语']);
  assert.deepEqual(stored.scenes, ['对荒唐事情无言以对']);
  assert.equal(library.listAliasesBySha(candidates[0].sha256)[0].alias, '保留手动标签');
  await index.tick();
  await index.tick();
  assert.equal(calls, 2);
  assert.deepEqual(await index.status(), { total: 2, indexed: 2, pending: 0, unclassified: 0, running: false });
});

test('未命中已有词族时高置信可创建，低置信仅保留待归类；失败图片不阻塞后续', async t => {
  let calls = 0;
  const created = [];
  const { library, index, candidates } = await fixture(t, async () => {
    calls += 1;
    if (calls === 1) throw new Error('upstream unavailable');
    return JSON.stringify({ description: '倒地躺平', scenes: ['疲惫不想工作'], familyIds: [],
      newFamily: { name: '疲惫躺平', terms: ['好累', '不想工作'] }, confidence: 'high' });
  }, { addFamily: async (name, terms) => { created.push({ name, terms }); return name; } });
  await index.tick();
  await index.tick();
  assert.equal(library.getImageSemantics(candidates[0].sha256), null);
  assert.deepEqual(library.getImageSemantics(candidates[1].sha256).familyIds, ['疲惫躺平']);
  assert.equal(created.length, 1);
  index.failures.clear();
  index.chatClient.complete = async () => JSON.stringify({ description: '模糊截图', confidence: 'low',
    newFamily: { name: '错误分类', terms: ['错误', '误判'] }, familyIds: ['无语'] });
  await index.tick();
  assert.deepEqual(library.getImageSemantics(candidates[0].sha256).familyIds, []);
  assert.equal(created.length, 1);
});

test('没有固定关键词也能按图片语义选图，轮换、排除删除图片并拒绝虚构候选', async t => {
  const inputs = [];
  const { library, index, candidates } = await fixture(t, async (_history, input, options) => {
    assert.equal(options.usageSource, 'longtu-semantic-select');
    inputs.push(JSON.parse(input));
    return JSON.stringify({ ids: [0, 1, 999, '1'], confidence: 'high' });
  });
  for (const candidate of candidates) library.saveImageSemantics(candidate.sha256, {
    description: '累瘫在地上', visibleText: ['我不干了'], scenes: ['工作劳累想休息'], keywords: ['疲劳'], familyIds: [], confidence: 'high',
  });
  assert.deepEqual(await index.select({ content: '连续加班五天，人要散架了', answer: '先歇会', scope: 'g1' }), [candidates[0].sha256]);
  assert.equal(inputs[0].candidates[0].scene[0], '工作劳累想休息');
  assert.deepEqual(await index.select({ content: '连续加班五天，人要散架了', scope: 'g1' }), [candidates[1].sha256]);
  library.deleteBySha(candidates[1].sha256);
  await index.select({ content: '好累', scope: 'g2' });
  assert.equal(inputs.at(-1).candidates.length, 1);
  index.chatClient.complete = async () => '{"ids":[999],"confidence":"high"}';
  assert.deepEqual(await index.select({ content: '不相关' }), []);
  index.chatClient.complete = async () => { throw new Error('timeout'); };
  assert.equal(await index.select({ content: '好累' }), null);
});

test('近期用过的贴切图片仍可选择，不被不相关的新图挤掉；中置信可用、低置信不发', async t => {
  let confidence = 'medium';
  const { library, index, candidates } = await fixture(t, async (_history, input) => {
    const rows = JSON.parse(input).candidates;
    return JSON.stringify({ ids: rows.filter(row => row.description === '疲惫').map(row => row.id), confidence });
  });
  for (const [i, candidate] of candidates.entries()) library.saveImageSemantics(candidate.sha256, {
    description: i ? '庆祝' : '疲惫', confidence: 'high',
  });
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await index.select({ content: '加班累死了', scope: 'g' }), [candidates[0].sha256]);
  }
  confidence = 'low';
  assert.deepEqual(await index.select({ content: '加班累死了', scope: 'g' }), []);
});

test('大图库词族检索空返回后仍会筛选图片场景，并禁用检索思考避免耗尽短输出预算', async t => {
  const calls = [];
  const { library, index, candidates } = await fixture(t, async (_history, input, options) => {
    calls.push(options.usageSource);
    assert.deepEqual(options.thinking, { type: 'disabled' });
    if (options.usageSource === 'longtu-semantic-retrieve') throw new Error('大模型返回了空内容');
    assert.equal(JSON.parse(input).candidates.length, 80);
    return '{"ids":[0],"confidence":"medium"}';
  });
  while (candidates.length < 81) candidates.push({ sha256: candidates.length.toString(16).padStart(64, '0') });
  for (const row of candidates) library.saveImageSemantics(row.sha256, {
    description: '累了躺平', visibleText: ['累了'], scenes: ['疲劳'], keywords: ['加班'], confidence: 'high',
  });
  assert.equal((await index.select({ content: '加班到站不起来' })).length, 1);
  assert.deepEqual(calls, ['longtu-semantic-retrieve', 'longtu-semantic-select']);
});
