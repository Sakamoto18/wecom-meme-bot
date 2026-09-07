import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { MediaUsageTracker } from '../src/media-usage-tracker.js';

test('records media extraction usage independently', () => {
  const file = `/tmp/media-usage-${process.pid}.sqlite`;
  rmSync(file, { force: true });
  const tracker = new MediaUsageTracker({ databaseFilePath: file, now: () => 1000 });
  tracker.record({ provider: 'xiaohongshu', downloadBytes: 123, durationMs: 20 });
  tracker.record({ provider: 'xiaohongshu', status: 'failed', errorStage: 'resolve' });
  const report = tracker.getReport({ startAt: 0, endAt: 2000 });
  assert.equal(report.totals.requests, 2);
  assert.equal(report.totals.downloadBytes, 123);
  assert.equal(report.byProvider.length, 2);
  tracker.close();
  rmSync(file, { force: true });
  rmSync(`${file}-shm`, { force: true });
  rmSync(`${file}-wal`, { force: true });
});
