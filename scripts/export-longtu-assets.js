import 'dotenv/config';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectImageExtension, MemeStore } from '../src/meme-store.js';
import { extractPerceptualHashes } from '../src/image-features.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const sourceDirectory = process.env.WECOM_EMOTION_DIR?.trim();
const targetDirectory = path.join(projectRoot, 'memes', 'longtu');
const indexPath = path.join(projectRoot, 'data', 'longtu-index.json');
const exclusionsPath = path.join(projectRoot, 'data', 'longtu-exclusions.json');
const approvalsPath = path.join(projectRoot, 'data', 'longtu-approvals.json');
const configuredLimit = Number.parseInt(process.env.LONGTU_LIMIT ?? '', 10);
const configuredMaxScore = Number.parseFloat(process.env.LONGTU_MAX_SCORE ?? '');

if (!sourceDirectory) {
  console.error('缺少 WECOM_EMOTION_DIR，无法从企微缓存导出龙图。');
  process.exit(1);
}

if (path.resolve(sourceDirectory) === path.resolve(targetDirectory)) {
  console.error('WECOM_EMOTION_DIR 不能指向导出目录 memes/longtu。');
  process.exit(1);
}

let approvalReview;
try {
  approvalReview = JSON.parse(await readFile(approvalsPath, 'utf8'));
} catch (error) {
  console.error(`无法读取龙图允许清单 ${approvalsPath}：${error.message}`);
  process.exit(1);
}

const approvedHashes = new Set(
  Array.isArray(approvalReview.approvedSha256)
    ? approvalReview.approvedSha256.filter((hash) => /^[a-f0-9]{64}$/i.test(hash))
    : [],
);
if (approvedHashes.size === 0 || approvedHashes.size !== approvalReview.approvedSha256?.length) {
  console.error('龙图允许清单为空或包含无效 SHA-256，已停止导出。');
  process.exit(1);
}

let reviewedTop = 0;
try {
  const exclusions = JSON.parse(await readFile(exclusionsPath, 'utf8'));
  reviewedTop = Number.isInteger(exclusions.reviewedTop) && exclusions.reviewedTop > 0
    ? exclusions.reviewedTop
    : 0;
} catch {
  // 没有人工审查记录时继续使用环境变量中的保守阈值。
}

const store = new MemeStore([sourceDirectory], {
  longtuIndexPath: indexPath,
  longtuExclusionsPath: exclusionsPath,
  longtuSourceDirectory: sourceDirectory,
  longtuLimit: reviewedTop || (Number.isInteger(configuredLimit) && configuredLimit > 0
    ? configuredLimit
    : undefined),
  longtuMaxScore: reviewedTop > 0
    ? Number.POSITIVE_INFINITY
    : (Number.isFinite(configuredMaxScore) && configuredMaxScore > 0
    ? configuredMaxScore
    : undefined),
});

const candidates = await store.loadLongtuCandidates();
await mkdir(targetDirectory, { recursive: true });

const exported = [];
const exportedHashes = new Set();
for (const candidate of candidates) {
  const buffer = await readFile(candidate.path);
  const extension = detectImageExtension(buffer);
  if (!extension) continue;
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (!approvedHashes.has(sha256)) continue;
  const filename = `${sha256}${extension}`;
  await copyFile(candidate.path, path.join(targetDirectory, filename));
  exportedHashes.add(sha256);
  exported.push({
    filename,
    sha256,
    score: candidate.score,
    perceptualHashes: await extractPerceptualHashes(buffer),
  });
}

const missingApprovals = [...approvedHashes].filter((hash) => !exportedHashes.has(hash));
if (missingApprovals.length > 0) {
  console.error(`有 ${missingApprovals.length} 张审核通过的龙图未在企微缓存索引中找到，保留原导出清单。`);
  process.exit(1);
}

const manifest = {
  version: 2,
  generatedAt: new Date().toISOString(),
  count: exported.length,
  reviewedTop,
  approvalReview: {
    reviewedCount: approvalReview.reviewedCount,
    approvedCount: approvedHashes.size,
    reviewedAt: approvalReview.reviewedAt,
  },
  files: exported,
};
await writeFile(
  path.join(targetDirectory, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

const exportedFilenames = new Set(exported.map((entry) => entry.filename));
const staleEntries = await readdir(targetDirectory, { withFileTypes: true });
let removedCount = 0;
for (const entry of staleEntries) {
  if (!entry.isFile() || exportedFilenames.has(entry.name) || entry.name === 'manifest.json') {
    continue;
  }
  if (!['.png', '.jpg', '.jpeg', '.gif'].includes(path.extname(entry.name).toLowerCase())) {
    continue;
  }
  await rm(path.join(targetDirectory, entry.name));
  removedCount += 1;
}

console.log(`已导出 ${exported.length} 张白名单龙图到 ${targetDirectory}，清理 ${removedCount} 张未通过副本`);
