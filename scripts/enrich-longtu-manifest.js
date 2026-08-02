import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPerceptualHashes } from '../src/image-features.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const longtuDirectory = path.join(projectRoot, 'memes', 'longtu');
const manifestPath = path.join(longtuDirectory, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
  throw new Error('龙图清单为空，无法生成感知哈希');
}

for (const entry of manifest.files) {
  if (!entry?.filename || path.basename(entry.filename) !== entry.filename) {
    throw new Error('龙图清单包含无效文件名');
  }
  const buffer = await readFile(path.join(longtuDirectory, entry.filename));
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== entry.sha256) {
    throw new Error(`龙图内容哈希不匹配：${entry.filename}`);
  }
  entry.perceptualHashes = await extractPerceptualHashes(buffer);
}

manifest.version = 2;
manifest.featuresUpdatedAt = new Date().toISOString();
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`已为 ${manifest.files.length} 张龙图写入感知哈希`);
