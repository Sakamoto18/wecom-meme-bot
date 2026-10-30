import process from 'node:process';
import WebSocket from 'ws';

// AstrBot's aiocqhttp adapter only accepts reverse WebSocket connections.
// NapCat can expose a local forward WebSocket server, so this small bridge
// keeps the two endpoints local while making the QQ side an outbound client
// from the bot's point of view. It forwards OneBot frames unchanged in both
// directions and never logs payloads or tokens.
const napcatUrl = String(process.env.ONEBOT_FORWARD_URL || 'ws://127.0.0.1:6201/ws').trim();
const astrbotUrl = String(process.env.ONEBOT_ASTRBOT_URL || 'ws://127.0.0.1:6199/ws').trim();
const token = String(process.env.ONEBOT_TOKEN || '').trim();
const selfId = String(process.env.NAPCAT_ACCOUNT || '').trim();
const reconnectMs = Math.max(1000, Number(process.env.ONEBOT_RELAY_RECONNECT_MS || 5000));

if (!token) throw new Error('ONEBOT_TOKEN is required for the local OneBot relay.');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function connect(url, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const headers = {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Longtu-OneBot-Forward-Relay/1',
    };
    if (selfId) headers['X-Self-ID'] = selfId;
    const socket = new WebSocket(url, {
      headers,
      handshakeTimeout: 5000,
      perMessageDeflate: false,
      maxPayload: 50 * 1024 * 1024,
    });
    socket.once('open', () => {
      settled = true;
      console.log(`[relay] ${label} connected`);
      resolve(socket);
    });
    socket.once('error', error => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function closeQuietly(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  try { socket.close(1000, 'relay reconnect'); } catch {}
}

async function runPair() {
  let astrbot;
  let napcat;
  try {
    // Connect AstrBot first so NapCat's initial lifecycle event has a target.
    astrbot = await connect(astrbotUrl, 'AstrBot');
    napcat = await connect(napcatUrl, 'NapCat forward');

    let closed;
    const closedPromise = new Promise(resolve => { closed = resolve; });
    const forward = (source, target, label) => {
      source.on('message', data => {
        if (target.readyState === WebSocket.OPEN) target.send(data);
      });
      source.once('close', () => {
        console.warn(`[relay] ${label} closed`);
        closed();
      });
      source.once('error', error => {
        console.warn(`[relay] ${label} error: ${error.message}`);
        closed();
      });
    };
    forward(napcat, astrbot, 'NapCat forward');
    forward(astrbot, napcat, 'AstrBot');
    await closedPromise;
  } catch (error) {
    console.warn(`[relay] connection failed: ${error.message}`);
  } finally {
    closeQuietly(napcat);
    closeQuietly(astrbot);
  }
}

let stopping = false;
const stop = () => { stopping = true; };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

console.log(`[relay] starting: NapCat=${napcatUrl} AstrBot=${astrbotUrl}`);
while (!stopping) {
  await runPair();
  if (!stopping) await sleep(reconnectMs);
}
console.log('[relay] stopped');
