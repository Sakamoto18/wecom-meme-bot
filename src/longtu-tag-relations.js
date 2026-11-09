import { readFileSync } from 'node:fs';

// No model call or prompt expansion: the relation vocabulary is a local index.
// Single-character pool terms only match whole manual tags, never OCR substrings.
let defaults = [];
try {
  defaults = JSON.parse(readFileSync(new URL('../config/longtu-tag-relations.json', import.meta.url), 'utf8')).groups;
} catch (error) {
  console.warn(`图库关联词库不可用，继续使用原有文字匹配：${error.message}`);
}

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/gu, '').trim();
}

export function normalizeLongtuTagRelations(value) {
  const groups = Array.isArray(value) ? value : value?.groups;
  if (!Array.isArray(groups)) return [];
  const terms = (items, minimum) => [...new Set((Array.isArray(items) ? items : [])
    .filter((item) => typeof item === 'string').map(normalize)
    .filter((item) => item.length >= minimum && item.length <= 32))];
  return groups.slice(0, 128).flatMap((group) => {
    const inputTerms = terms(group?.inputTerms ?? group?.terms, 1);
    const poolTerms = terms(group?.poolTerms ?? group?.terms ?? inputTerms, 1);
    if (!inputTerms.length || !poolTerms.length) return [];
    return [{ id: String(group.id || inputTerms[0]).slice(0, 48),
      hostile: group.hostile === true, inputTerms, poolTerms }];
  });
}

export const DEFAULT_LONGTU_TAG_RELATIONS = normalizeLongtuTagRelations(defaults);
const compiled = new WeakMap();
const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

function matcher(term) {
  if (/^[a-z]+$/u.test(term)) {
    // Preserve word boundaries: nm is not environment, 5 nm or nmcli.
    const letters = [...term].map((c) => c === 's' ? '[s$5]' : c === 'l' ? '[l1]' : quote(c));
    return new RegExp(`(?<![a-z0-9])${letters.join('[\\s._-]*')}(?![a-z0-9])`, 'u');
  }
  return new RegExp(quote(term), 'u');
}

// Keep Latin word boundaries through every selection path, including the old
// OCR fallback. Otherwise nmcli or a numeric nanometre value can select nm.
export function longtuTagInput(value) {
  return normalize(value).slice(0, 2000)
    .replace(/\d+(?:\.\d+)?\s*nm(?![a-z0-9])/gu, ' ');
}

export function containsLongtuTag(value, tag) {
  const term = normalize(tag);
  if (!term) return false;
  const text = longtuTagInput(value);
  return term.length === 1 ? text === term : matcher(term).test(text);
}

function getGroups(options) {
  const source = options.relationGroups ?? DEFAULT_LONGTU_TAG_RELATIONS;
  if (!source || typeof source !== 'object') return [];
  if (!compiled.has(source)) {
    compiled.set(source, normalizeLongtuTagRelations(source).map((group) => ({ ...group,
      inputs: group.inputTerms.map(matcher),
      pools: group.poolTerms.map((term) => ({ term, pattern: matcher(term) })),
    })));
  }
  return compiled.get(source);
}

function poolHit(binding, group) {
  const alias = normalize(binding?.alias);
  if (!alias || binding?.deleted_at || binding?.deletedAt || binding?.blocked) return false;
  return group.pools.some(({ term, pattern }) => term.length === 1
    ? binding.source === 'manual' && alias === term : pattern.test(alias));
}

export function matchRelatedLongtuTags(content, bindings, options = {}) {
  const text = longtuTagInput(content);
  if (!text) return [];
  // Explicitly configured Chinese keyword families also apply inside ordinary
  // sentences (e.g. 鹿 -> 鹿起来). Single-letter Latin terms still need an exact
  // match; single-character pool tags remain manual-only below.
  const inputHit = (group, pattern, index) => group.inputTerms[index].length === 1
    && !/^\p{Script=Han}$/u.test(group.inputTerms[index])
    ? text === group.inputTerms[index] : pattern.test(text);
  const available = getGroups(options).filter(group => !group.hostile || options.allowHostile !== false);
  const groups = available.filter(group => group.inputs.some((pattern, index) => inputHit(group, pattern, index)));
  if (!groups.length) return [];
  // Shared explicit tags connect admin-created families such as 鹿/炉管/开撸.
  const matchedKeyword = groups[0].inputTerms.find((term, index) => inputHit(groups[0], groups[0].inputs[index], index));
  const connectedTerms = new Set(groups.flatMap(group => [...group.inputTerms, ...group.poolTerms]));
  for (let changed = true; changed;) {
    changed = false;
    for (const group of available) {
      if (groups.includes(group) || ![...group.inputTerms, ...group.poolTerms].some(term => connectedTerms.has(term))) continue;
      groups.push(group);
      for (const term of [...group.inputTerms, ...group.poolTerms]) connectedTerms.add(term);
      changed = true;
    }
  }
  const unique = new Map();
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    if (!binding?.sha256 || !binding?.alias) continue;
    const matchedGroups = groups.filter((group) => poolHit(binding, group));
    if (matchedGroups.length === 0) continue;
    const previous = unique.get(binding.sha256);
    const relationIds = [...new Set([
      ...(previous?.relationIds ?? []),
      ...matchedGroups.map((group) => group.id),
    ])];
    unique.set(binding.sha256, {
      ...binding,
      matchedKeyword: previous?.matchedKeyword ?? matchedKeyword,
      relationId: relationIds[0],
      relationIds,
      matchType: 'tag-relation',
    });
  }
  return [...unique.values()];
}
