import test from 'node:test';
import assert from 'node:assert/strict';
import { listenMockXhs } from '../src/mock-xhs-service.js';
import { resolveMockXhsShare } from '../src/mock-xhs-client.js';

test('Mock XHS follows short links, signs detail requests, and selects the highest stream', async () => {
  const service = await listenMockXhs();
  try {
    const resolved = await resolveMockXhsShare(`${service.baseUrl}/s/demo123`, {
      secret: 'mock-xhs-secret-v1',
    });
    assert.equal(resolved.noteId, 'demo123');
    assert.equal(resolved.quality, '1080p');
    assert.match(resolved.videoUrl, /demo123-1080\.mp4/u);
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
  }
});

test('Mock XHS rejects an unsigned detail request', async () => {
  const service = await listenMockXhs();
  try {
    const response = await fetch(`${service.baseUrl}/api/notes/demo123`);
    assert.equal(response.status, 403);
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
  }
});
