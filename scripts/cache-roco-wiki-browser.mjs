// Optional browser transport for Wiki visitor checks. Requires Playwright;
// ROCO_PLAYWRIGHT_MODULE may point to an existing Playwright installation.
// Connect only to a dedicated browser profile, never copy its cookies to logs.
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const { chromium } = await import(process.env.ROCO_PLAYWRIGHT_MODULE || 'playwright');
const [cdp = 'http://127.0.0.1:9253', cache = 'data/roco-wiki-cache', listFile] = process.argv.slice(2);
if (!listFile) throw new Error('Usage: node scripts/cache-roco-wiki-browser.mjs CDP_URL CACHE_DIR TITLES_JSON');
const titles = JSON.parse(await readFile(listFile, 'utf8'));
await mkdir(cache, { recursive: true });
const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0];
const page = await context.newPage();
try {
  await page.goto('https://wiki.biligame.com/nrc/', { waitUntil: 'domcontentloaded' });
  for (const [i, title] of titles.entries()) {
    const file = path.join(cache, `${createHash('sha256').update(title).digest('hex')}.json`);
    try { await access(file); continue; } catch { /* fetch missing cache */ }
    const data = await page.evaluate(async (title) => {
      const params = new URLSearchParams({ action: 'parse', page: title, prop: 'text|revid', format: 'json', redirects: '1' });
      const response = await fetch(`/nrc/api.php?${params}`, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`Wiki HTTP ${response.status}: ${title}`);
      const data = await response.json();
      if (!data.parse?.text?.['*']) throw new Error(`Missing rendered page: ${title}`);
      return data;
    }, title);
    data.fetchedAt = new Date().toISOString();
    await writeFile(file, JSON.stringify(data));
    if ((i + 1) % 25 === 0 || i === titles.length - 1) console.log(`Cached ${i + 1}/${titles.length}: ${title}`);
    await new Promise(resolve => setTimeout(resolve, 800));
  }
} finally {
  await page.close();
  await browser.close(); // CDP disconnect; the user's persistent browser stays open.
}
