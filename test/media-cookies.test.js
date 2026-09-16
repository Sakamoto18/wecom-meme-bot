import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runYtDlp } from '../src/media-resolver.js';

for (const json of [false, true]) {
  test('yt-dlp isolates writable cookies and cleans on success/failure: json=' + json, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'media-cookie-test-'));
    const cookiesFile = path.join(dir, 'secret.txt');
    const original = json ? JSON.stringify([{ domain: '.douyin.com', name: 'session', value: 'test' }])
      : '# Netscape HTTP Cookie File\n.douyin.com\tTRUE\t/\tFALSE\t0\tsession\ttest\n';
    const command = path.join(dir, 'downloader');
    const outputDirectory = path.join(dir, 'cache');
    try {
      await writeFile(cookiesFile, original, { mode: 0o400 });
      const script = [
        '#!' + process.execPath,
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const cookiePath = args[args.indexOf('--cookies') + 1];",
        "const cookies = fs.readFileSync(cookiePath, 'utf8');",
        "if (!cookies.startsWith('# Netscape') || (fs.statSync(cookiePath).mode & 0o777) !== 0o600) process.exit(2);",
        "fs.appendFileSync(cookiePath, '# updated\\n');",
        "fs.appendFileSync('../used-paths', cookiePath + '\\n');",
        "if (args.at(-1).endsWith('/fail')) process.exit(1);",
        "const file = args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4');",
        "fs.writeFileSync(file, 'test-media');",
        "console.log(file);",
      ].join('\n');
      await writeFile(command, script, { mode: 0o700 });
      await Promise.all([
        runYtDlp('https://example.test/a', { command, cookiesFile, outputDirectory }),
        runYtDlp('https://example.test/b', { command, cookiesFile, outputDirectory }),
      ]);
      await assert.rejects(runYtDlp('https://example.test/fail', { command, cookiesFile, outputDirectory }));
      assert.equal(await readFile(cookiesFile, 'utf8'), original);
      const paths = (await readFile(path.join(dir, 'used-paths'), 'utf8')).trim().split('\n');
      assert.equal(new Set(paths).size, 3);
      assert.ok(paths.every(p => p !== cookiesFile));
      assert.ok((await readdir(outputDirectory)).every(p => !p.endsWith('.cookies.txt')));
    } finally {
      await chmod(cookiesFile, 0o600).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
}
