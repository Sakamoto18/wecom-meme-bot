import { readFile } from 'node:fs/promises';

const filePath = process.argv[2];
if (!filePath) {
  console.error('用法：node scripts/validate-jev-culture-dataset.mjs <dataset.jsonl>');
  process.exit(2);
}

const text = await readFile(filePath, 'utf8');
const errors = [];
const lines = text.split(/\r?\n/u).filter((line) => line.trim());
const enumValues = new Set(['ironic', 'sarcastic', 'self_deprecating', 'absurd', 'serious', 'neutral', 'unknown']);
const domainValues = new Set(['longtu', 'general', 'platform', 'none']);
const isText = (value, max) => typeof value === 'string' && value.length <= max;
const isList = (value, maxItems, maxLength) => Array.isArray(value)
  && value.length <= maxItems
  && value.every((item) => isText(item, maxLength));
const isProbability = (value) => typeof value === 'number' && value >= 0 && value <= 1;

function requireField(object, key, path) {
  if (!object || !(key in object)) errors.push(`${path}.${key} 缺失`);
  return object?.[key];
}

for (const [index, line] of lines.entries()) {
  const path = `第 ${index + 1} 行`;
  let sample;
  try { sample = JSON.parse(line); } catch (error) {
    errors.push(`${path} JSON 无法解析：${error.message}`);
    continue;
  }
  const input = requireField(sample, 'input', path);
  const target = requireField(sample, 'target', path);
  if (!isText(sample.id, 128)) errors.push(`${path}.id 无效`);
  if (!isText(input?.question, 800)) errors.push(`${path}.input.question 无效`);
  const literal = target?.literal;
  if (!isList(literal?.visual_facts, 6, 180)) errors.push(`${path}.target.literal.visual_facts 无效`);
  if (!isList(literal?.visible_text, 20, 180)) errors.push(`${path}.target.literal.visible_text 无效`);
  if (!isList(literal?.text_claims, 6, 180)) errors.push(`${path}.target.literal.text_claims 无效`);
  const pragmatic = target?.pragmatic;
  for (const key of ['scene_relation', 'actual_point', 'comic_mechanism']) {
    if (!isText(pragmatic?.[key], key === 'comic_mechanism' ? 240 : 500)) errors.push(`${path}.target.pragmatic.${key} 无效`);
  }
  if (!enumValues.has(pragmatic?.stance)) errors.push(`${path}.target.pragmatic.stance 无效`);
  if (pragmatic?.literal_only_risk !== undefined && !isProbability(pragmatic.literal_only_risk)) errors.push(`${path}.target.pragmatic.literal_only_risk 无效`);
  const culture = target?.culture;
  if (typeof culture?.unknown_concept !== 'boolean') errors.push(`${path}.target.culture.unknown_concept 无效`);
  if (!domainValues.has(culture?.culture_domain)) errors.push(`${path}.target.culture.culture_domain 无效`);
  if (!isProbability(culture?.retrieval_needed)) errors.push(`${path}.target.culture.retrieval_needed 无效`);
  if (!isList(culture?.query_terms, 8, 140)) errors.push(`${path}.target.culture.query_terms 无效`);
  const guidance = target?.reply_guidance;
  if (!Array.isArray(guidance?.candidate_associations) || guidance.candidate_associations.length > 2) errors.push(`${path}.target.reply_guidance.candidate_associations 无效`);
  else for (const association of guidance.candidate_associations) {
    for (const key of ['idea', 'why_fit', 'risk']) if (!isText(association?.[key], key === 'risk' ? 140 : 180)) errors.push(`${path}.target.reply_guidance.candidate_associations 字段无效`);
  }
  if (!isList(guidance?.avoid_literal_repetition, 4, 160)) errors.push(`${path}.target.reply_guidance.avoid_literal_repetition 无效`);
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Jev 文化数据集校验通过：${lines.length} 条`);
