import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchRelatedLongtuTags,
  normalizeLongtuTagRelations,
} from '../src/longtu-tag-relations.js';
import {
  matchLongtuAliasRequest,
  matchLongtuSceneAliases,
} from '../src/longtu-management.js';

const sha = (digit) => String(digit).repeat(64).slice(0, 64);

const bindings = [
  { alias: 'nm', sha256: sha(1), source: 'manual' },
  { alias: 'nmb', sha256: sha(2), source: 'manual' },
  { alias: 'mlgb', sha256: sha(3), source: 'manual' },
  { alias: '你妈', sha256: sha(4), source: 'manual' },
  { alias: 'environment', sha256: sha(5), source: 'manual' },
  { alias: 'nmcli', sha256: sha(6), source: 'manual' },
];

test('nm 词族会合并相近 tag 池，并保持英文短词边界', () => {
  const matches = matchRelatedLongtuTags('nm', bindings);
  assert.deepEqual(
    matches.map((entry) => entry.alias),
    ['nm', 'nmb', 'mlgb', '你妈'],
  );
  assert.deepEqual(
    matchRelatedLongtuTags('environment nmcli 5 nm', bindings).map((entry) => entry.alias),
    [],
  );
});

test('关联词族可合并多个 tag，且同一 sha 只保留一次', () => {
  const groups = normalizeLongtuTagRelations([
    { id: 'a', inputTerms: ['甲甲'], poolTerms: ['甲甲', '共同'] },
    { id: 'b', inputTerms: ['乙乙'], poolTerms: ['乙乙', '共同'] },
  ]);
  const customBindings = [
    { alias: '共同', sha256: sha(7), source: 'manual' },
    { alias: '甲甲', sha256: sha(8), source: 'manual' },
    { alias: '乙乙', sha256: sha(9), source: 'manual' },
  ];
  const matches = matchRelatedLongtuTags('甲甲乙乙', customBindings, {
    relationGroups: groups,
  });
  assert.deepEqual(matches.map((entry) => entry.sha256), [sha(7), sha(8), sha(9)]);
  assert.deepEqual(matches[0].relationIds, ['a', 'b']);
});

test('直接 @bot 请求可以从关联池轮换候选，普通文本不被关系词族抢答', () => {
  const direct = matchLongtuAliasRequest('nm', bindings, {
    allowRelatedDirect: true,
  });
  assert.deepEqual(direct.sha256s, [sha(1), sha(2), sha(3), sha(4)]);
  assert.equal(
    matchLongtuAliasRequest('nm', bindings.filter((entry) => entry.alias !== 'nm')),
    null,
    '没有精确 alias 时，关系词族只在 @bot/private 路径启用',
  );
});

test('场景匹配把关联词族交给候选池，而不是固定返回一个关键词', () => {
  const matches = matchLongtuSceneAliases('这也太 nm 了', '', bindings);
  assert.deepEqual(
    matches.map((entry) => entry.sha256),
    [sha(1), sha(2), sha(3), sha(4)],
  );
});
