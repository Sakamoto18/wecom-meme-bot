import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

/**
 * Local-only XHS-like service for exercising the resolver contract.
 * It intentionally uses a documented test secret and never contacts XHS.
 */
export const MOCK_XHS_SECRET = 'mock-xhs-secret-v1';

const NOTES = new Map([
  ['demo123', {
    noteId: 'demo123',
    title: 'Mock video note',
    image: 'http://127.0.0.1:0/media/demo123-cover.jpg',
    videos: [
      { quality: '720p', url: 'http://127.0.0.1:0/media/demo123-720.mp4' },
      { quality: '1080p', url: 'http://127.0.0.1:0/media/demo123-1080.mp4' },
    ],
  }],
]);

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sign({ noteId, timestamp, nonce }, secret = MOCK_XHS_SECRET) {
  return createHmac('sha256', secret)
    .update(`${noteId}.${timestamp}.${nonce}`)
    .digest('hex');
}

export function createMockXhsServer({ secret = MOCK_XHS_SECRET, now = () => Date.now() } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname.startsWith('/s/')) {
      const noteId = url.pathname.slice('/s/'.length);
      if (!NOTES.has(noteId)) return json(response, 404, { error: 'short link not found' });
      response.writeHead(302, { location: `/explore/${noteId}?xsec_token=mock-token` });
      return response.end();
    }
    if (request.method === 'GET' && url.pathname.startsWith('/explore/')) {
      const noteId = url.pathname.slice('/explore/'.length);
      if (!NOTES.has(noteId)) return json(response, 404, { error: 'note not found' });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return response.end(`<html><meta property="og:title" content="Mock video note"><script>window.__NOTE_ID__="${noteId}"</script></html>`);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/notes/')) {
      const noteId = url.pathname.slice('/api/notes/'.length);
      const note = NOTES.get(noteId);
      if (!note) return json(response, 404, { error: 'note not found' });
      const timestamp = Number(request.headers['x-mock-timestamp']);
      const deviceId = String(request.headers['x-mock-device-id'] || '');
      const nonce = String(request.headers['x-mock-nonce'] || '');
      const supplied = String(request.headers['x-mock-signature'] || '');
      const expected = sign({ noteId, timestamp, nonce }, secret);
      const valid = Number.isFinite(timestamp)
        && Math.abs(now() - timestamp) <= 30_000
        && deviceId.length >= 8
        && nonce.length >= 8
        && /^[a-f0-9]{64}$/u.test(supplied)
        && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
      if (!valid) return json(response, 403, { error: 'mock risk control: invalid signature' });
      return json(response, 200, { success: true, data: note });
    }
    if (request.method === 'GET' && url.pathname.startsWith('/media/')) {
      response.writeHead(200, { 'content-type': 'video/mp4' });
      return response.end(Buffer.from('MOCK_MP4_PAYLOAD'));
    }
    return json(response, 404, { error: 'not found' });
  });
  return { server, sign: (input) => sign(input, secret), notes: NOTES };
}

export async function listenMockXhs(options = {}) {
  const { server, sign, notes } = createMockXhsServer(options);
  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, sign, notes, baseUrl, requestId: randomUUID() };
}
