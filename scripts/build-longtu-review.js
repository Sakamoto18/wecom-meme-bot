import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jimp, loadFont } from 'jimp';
import { SANS_16_BLACK } from 'jimp/fonts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(projectRoot, 'data/longtu-index.json');
const offset = Math.max(0, Number.parseInt(process.argv[2] ?? '0', 10) || 0);
const count = Math.max(1, Number.parseInt(process.argv[3] ?? '40', 10) || 40);
const outputPath = path.join(projectRoot, `data/longtu-review-${offset + 1}-${offset + count}.png`);
const index = JSON.parse(await readFile(indexPath, 'utf8'));
const entries = index.entries.slice(offset, offset + count);
const columns = 5;
const cellSize = 180;
const labelHeight = 22;
const rows = Math.ceil(entries.length / columns);
const sheet = new Jimp({ width: columns * cellSize, height: rows * cellSize, color: 0xffffffff });
const font = await loadFont(SANS_16_BLACK);

for (let position = 0; position < entries.length; position += 1) {
  try {
    const buffer = await readFile(entries[position].path);
    const image = await Jimp.read(buffer);
    image.contain({ w: cellSize - 12, h: cellSize - labelHeight - 8 });
    const x = (position % columns) * cellSize + 6;
    const rowY = Math.floor(position / columns) * cellSize;
    const y = rowY + labelHeight;
    sheet.composite(image, x, y);
    sheet.print({
      font,
      x,
      y: rowY + 2,
      text: `#${offset + position + 1}`,
    });
  } catch {
    // 损坏图片留空，索引构建阶段会记录失败数量。
  }
}

await mkdir(path.dirname(outputPath), { recursive: true });
await sheet.write(outputPath);
console.log(outputPath);
