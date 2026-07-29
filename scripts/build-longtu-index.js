import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const emotionDirectory = process.env.WECOM_EMOTION_DIR?.trim();
const requestedTopCount = Number.parseInt(process.argv[2] ?? '1500', 10);
const topCount = Number.isFinite(requestedTopCount) && requestedTopCount > 0
  ? requestedTopCount
  : 1500;

if (!emotionDirectory) {
  console.error('缺少 WECOM_EMOTION_DIR，请先在 .env 中填写企微 Emotion 目录。');
  process.exit(1);
}

const buildDirectory = path.join(projectRoot, '.build');
const sourcePath = path.join(projectRoot, 'scripts/vision-indexer.m');
const binaryPath = path.join(buildDirectory, 'vision-indexer');
const referencesDirectory = path.join(projectRoot, 'references/longtu');
const outputPath = path.join(projectRoot, 'data/longtu-index.json');

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
], {
  cwd: projectRoot,
  stdio: 'inherit',
});
if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}

const index = spawnSync(binaryPath, [referencesDirectory, emotionDirectory, outputPath, String(topCount)], {
  cwd: projectRoot,
  stdio: 'inherit',
});
process.exit(index.status ?? 1);
