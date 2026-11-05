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
