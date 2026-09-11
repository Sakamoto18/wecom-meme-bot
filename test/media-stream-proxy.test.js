import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { proxyRemoteMedia } from '../src/media-stream-proxy.js';

class ClientResponse extends Writable {
  chunks = [];
  headersSent = false;
  _write(chunk, _encoding, callback) { this.chunks.push(chunk); callback(); }
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }
  text() { return Buffer.concat(this.chunks).toString(); }
}
const logger = { info() {}, warn() {} };
const media = { remoteUrl: 'https://cdn.example/primary', backupUrls: ['https://cdn.example/backup'],
  requestHeaders: { referer: 'https://www.bilibili.com/' } };

test('视频源首包超时后切换备用 CDN，保留请求头', async () => {
  const response = new ClientResponse();
  const calls = [];
  await proxyRemoteMedia({ headers: {} }, response, media, { timeoutMs: 20, logger,
    fetchImpl: async (url, options) => {
      calls.push({url,headers:options.headers});
      if (url === media.remoteUrl) return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once:true });
      });
      return new Response('video', {headers:{'content-length':'5'}});
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.text(), 'video');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.referer, 'https://www.bilibili.com/');
});

test('CDN 传输中断后按字节偏移续传，不重复写入开头', async () => {
  const response = new ClientResponse();
  const requests = [];
  let reads = 0;
  await proxyRemoteMedia({ headers: {} }, response, media, { logger,
    fetchImpl: async (url, options) => {
      requests.push(options.headers.range);
      if (url === media.remoteUrl) return {
        ok:true,status:200,headers:new Headers({'content-length':'10'}),
        body: { getReader: () => ({
          read: async () => {if (reads++ === 0) return {done:false,value:Buffer.from('0123')}; throw new Error('terminated');},
          cancel: async () => {},
        }) },
      };
      return new Response('456789', {status:206,headers:{'content-length':'6','content-range':'bytes 4-9/10'}});
    },
  });
  assert.deepEqual(requests, [undefined, 'bytes=4-9']);
  assert.equal(response.text(), '0123456789');
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-length'], '10');
});

test('客户端 Range 请求和响应正确透传', async () => {
  const response = new ClientResponse();
  await proxyRemoteMedia({ headers: {range:'bytes=5-8'} }, response, media, { logger,
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.range, 'bytes=5-8');
      return new Response('5678', {status:206,headers:{'content-length':'4','content-range':'bytes 5-8/10'}});
    },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers['content-range'], 'bytes 5-8/10');
  assert.equal(response.text(), '5678');
});

test('备用源忽略续传 Range 时停止发送，避免损坏视频', async () => {
  const response = new ClientResponse();
  let reads = 0;
  await proxyRemoteMedia({ headers: {} }, response, media, { logger,
    fetchImpl: async url => url === media.remoteUrl ? {
      ok:true,status:200,headers:new Headers({'content-length':'10'}),
      body:{getReader:()=>({
        read:async()=>{if(reads++===0)return {done:false,value:Buffer.from('0123')};throw new Error('terminated');},
        cancel:async()=>{},
      })},
    } : new Response('0123456789',{headers:{'content-length':'10'}}),
  });
  assert.equal(response.text(), '0123');
  assert.equal(response.destroyed, true);
});

test('所有 CDN 失败时返回明确的 502', async () => {
  const response = new ClientResponse();
  await proxyRemoteMedia({ headers: {} }, response, media, {logger,
    fetchImpl:async()=>new Response('',{status:403}),
  });
  assert.equal(response.status, 502);
  assert.equal(JSON.parse(response.text()).ok, false);
});
