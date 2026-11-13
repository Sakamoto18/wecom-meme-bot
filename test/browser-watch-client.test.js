import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { requestBrowserWatch } from '../src/browser-watch-client.js';

test('网页观看不用fetch，等待完整HTTP响应并保留provider失败原因', async t => {
  let statusCode = 200;
  let body = {mode: 'browser-screenshots', seconds: 224};
  t.mock.method(http, 'request', (url, options, callback) => {
    assert.equal(url.pathname, '/bilibili-watch');
    assert.equal(options.method, 'POST');
    const req = new EventEmitter();
    req.end = data => {
      assert.equal(JSON.parse(data).seconds, 300);
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = statusCode;
        callback(response);
        const json = JSON.stringify(body);
        response.emit('data', Buffer.from(json.slice(0, 8)));
        response.emit('data', Buffer.from(json.slice(8)));
        response.emit('end');
      });
    };
    return req;
  });
  assert.equal((await requestBrowserWatch('http://provider', 'https://www.bilibili.com/video/BV1Epx96EEBG', 300)).seconds, 224);
  statusCode = 502; body = {error: '播放器停滞'};
  await assert.rejects(requestBrowserWatch('http://provider', 'https://www.bilibili.com/video/BV1Epx96EEBG', 300), /播放器停滞/);
});

test('连接断开返回具体错误并清理总等待计时器', async t => {
  t.mock.method(http, 'request', () => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => req.emit('error', new Error('ECONNRESET')));
    return req;
  });
  await assert.rejects(requestBrowserWatch('http://provider', 'https://www.bilibili.com/video/BV1Epx96EEBG', 300), /ECONNRESET/);
});

test('观看空位繁忙保留结构化错误供调度延期', async t => {
  t.mock.method(http, 'request', (_url, _options, callback) => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter();response.statusCode = 503;callback(response);
      response.emit('data', Buffer.from(JSON.stringify({ error: '等待空位超时，尚未观看', code: 'WATCH_BUSY' })));
      response.emit('end');
    });
    return req;
  });
  await assert.rejects(requestBrowserWatch('http://provider', 'https://www.bilibili.com/video/BV1Epx96EEBG', 300),
    error => error.code === 'WATCH_BUSY' && /尚未观看/.test(error.message));
});
