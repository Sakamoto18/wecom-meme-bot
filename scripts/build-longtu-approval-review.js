import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jimp, loadFont } from 'jimp';
import { SANS_16_BLACK } from 'jimp/fonts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(projectRoot, 'memes', 'longtu');
const manifestPath = path.join(sourceDirectory, 'manifest.json');
const outputDirectory = path.join(projectRoot, 'data', 'longtu-approval-review-lite');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const files = Array.isArray(manifest.files) ? manifest.files : [];
const pageSize = 48;
const columns = 6;
const cellWidth = 160;
const cellHeight = 160;
const labelHeight = 34;
const font = await loadFont(SANS_16_BLACK);

await mkdir(outputDirectory, { recursive: true });

for (let offset = 0; offset < files.length; offset += pageSize) {
  const page = files.slice(offset, offset + pageSize);
  const rows = Math.ceil(page.length / columns);
  const sheet = new Jimp({
    width: columns * cellWidth,
    height: rows * cellHeight,
    color: 0xffffffff,
  });

  for (let position = 0; position < page.length; position += 1) {
    const entry = page[position];
    try {
      const image = await Jimp.read(path.join(sourceDirectory, entry.filename));
      image.contain({ w: cellWidth - 10, h: cellHeight - labelHeight - 6 });
      const x = (position % columns) * cellWidth + 6;
      const rowY = Math.floor(position / columns) * cellHeight;
      sheet.composite(image, x, rowY + labelHeight);
      sheet.print({
        font,
        x,
        y: rowY + 2,
        text: `#${offset + position + 1} ${entry.sha256.slice(0, 8)}\n${Number(entry.score).toFixed(4)}`,
      });
    } catch {
      // 损坏或已被清理的图片留空，不能进入允许清单。
    }
  }

  const first = String(offset + 1).padStart(3, '0');
  const last = String(offset + page.length).padStart(3, '0');
  const outputPath = path.join(outputDirectory, `${first}-${last}.jpg`);
  await sheet.write(outputPath, { quality: 55 });
  console.log(outputPath);
}
