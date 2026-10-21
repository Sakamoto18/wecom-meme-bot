import { config as loadEnvironment } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QqGroupMemory } from '../src/group-memory.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '..');

loadEnvironment({
  path: process.env.QQ_ENV_FILE?.trim() || path.join(projectRoot, '.env.qq'),
  quiet: true,
});

function parseSet(value) {
  return new Set(String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean));
}

function parseGroupUserMap(value) {
  const result = new Map();
  for (const entry of String(value ?? '').split(',')) {
    const separator = entry.indexOf(':');
    if (separator <= 0) continue;
    const groupId = entry.slice(0, separator).trim();
    const userIds = entry.slice(separator + 1)
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean);
    if (!groupId || userIds.length === 0) continue;
    result.set(groupId, [...new Set([...(result.get(groupId) ?? []), ...userIds])]);
  }
  return result;
}

const topicGroups = parseSet(process.env.QQ_TOPIC_MEMORY_GROUPS);
const styleGroups = parseSet(process.env.QQ_GROUP_STYLE_GROUPS);
const effectiveGroups = new Set([...topicGroups, ...styleGroups]);
if (effectiveGroups.size === 0) {
  throw new Error('QQ_TOPIC_MEMORY_GROUPS 或 QQ_GROUP_STYLE_GROUPS 至少配置一个群');
}

const memory = new QqGroupMemory({
  databaseFilePath: path.resolve(
    projectRoot,
    process.env.QQ_GROUP_MEMORY_DATABASE_FILE?.trim() || 'data/qq-group-memory.sqlite',
  ),
  enabledGroups: topicGroups,
  // 回填按显式配置分别执行：只开话题的群不额外生成语感卡，只开语感的群
  // 也不重建话题。这样首次启用时不会因为默认回退多花一次模型调用。
  styleGroups,
  referenceBotsByGroup: parseGroupUserMap(
    process.env.QQ_GROUP_REFERENCE_BOTS?.trim() || '239375116:3791754277',
  ),
  logger: console,
});

try {
  const qqMemoryPath = path.resolve(
    projectRoot,
    process.env.QQ_MEMORY_DATABASE_FILE?.trim() || 'data/qq-memory.sqlite',
  );
  const result = await memory.backfillFromQqMemoryDatabase(qqMemoryPath, {
    groups: [...effectiveGroups],
    rebuildTopics: topicGroups.size > 0,
  });
  console.log(`群事件回填完成：inserted=${result.inserted} topic_assignments=${result.topics}`);
  for (const groupId of styleGroups) {
    const updated = await memory.refreshStyleProfile(groupId);
    console.log(`群语感卡：group=${groupId} updated=${updated ? 'yes' : 'no（样本不足）'}`);
  }
  console.log(`群记忆统计：${JSON.stringify(memory.getStats())}`);
} finally {
  memory.close();
}
