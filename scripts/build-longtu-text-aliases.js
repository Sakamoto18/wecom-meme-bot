import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeLongtuAlias } from '../src/longtu-management.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDirectory = path.join(projectRoot, '.build');
const sourcePath = path.join(projectRoot, 'scripts/longtu-ocr.m');
const binaryPath = path.join(buildDirectory, 'longtu-ocr');
const longtuDirectory = path.join(projectRoot, 'memes/longtu');
const rawOcrPath = path.join(buildDirectory, 'longtu-ocr.json');
const manifestPath = path.join(longtuDirectory, 'manifest.json');
const outputPath = path.join(projectRoot, 'config/longtu-text-aliases.json');

mkdirSync(buildDirectory, { recursive: true });

const compile = spawnSync('clang', [
  '-fobjc-arc',
  '-fblocks',
  '-framework', 'Foundation',
  '-framework', 'Vision',
  '-framework', 'ImageIO',
  '-framework', 'CoreGraphics',
  sourcePath,
  '-o', binaryPath,
], { cwd: projectRoot, stdio: 'inherit' });
if (compile.status !== 0) process.exit(compile.status ?? 1);

const recognize = spawnSync(binaryPath, [longtuDirectory, rawOcrPath], {
  cwd: projectRoot,
  stdio: 'inherit',
});
if (recognize.status !== 0) process.exit(recognize.status ?? 1);

const [manifest, ocr] = await Promise.all([
  readFile(manifestPath, 'utf8').then(JSON.parse),
  readFile(rawOcrPath, 'utf8').then(JSON.parse),
]);
const shaByFilename = new Map(
  (manifest.files ?? []).map((entry) => [entry.filename, entry.sha256]),
);
const candidatesByAlias = new Map();

function cleanOcrLine(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/[\s|]+/g, '')
    .replace(/^[^\p{L}\p{N}\p{Script=Han}]+|[^\p{L}\p{N}\p{Script=Han}，。！？!?]+$/gu, '')
    .trim();
}

function isUsefulAlias(alias) {
  if (!alias || /^\d+$/.test(alias)) return false;
  const meaningful = alias.match(/[\p{L}\p{N}\p{Script=Han}]/gu)?.length ?? 0;
  return meaningful >= 2 && alias.length <= 32;
}

function addCandidate(alias, sha256) {
  const normalized = normalizeLongtuAlias(alias);
  if (!isUsefulAlias(normalized)) return;
  const matches = candidatesByAlias.get(normalized) ?? new Set();
  matches.add(sha256);
  candidatesByAlias.set(normalized, matches);
}

for (const entry of ocr.entries ?? []) {
  const sha256 = shaByFilename.get(entry.filename);
  if (!sha256) continue;
  const lines = (entry.lines ?? []).map(cleanOcrLine).filter(Boolean);
  for (const line of lines) addCandidate(line, sha256);
  if (lines.length > 1) addCandidate(lines.join(''), sha256);
}

const aliases = [...candidatesByAlias]
  .filter(([, matches]) => matches.size === 1)
  .map(([alias, matches]) => ({ alias, sha256: [...matches][0] }))
  .sort((left, right) => left.alias.localeCompare(right.alias, 'zh-CN'));
const output = {
  version: 1,
  generatedAt: new Date().toISOString(),
  imageCount: shaByFilename.size,
  aliasCount: aliases.length,
  aliases,
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`已从 ${shaByFilename.size} 张龙图生成 ${aliases.length} 个唯一文字别名：${outputPath}`);
