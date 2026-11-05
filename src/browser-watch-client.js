import http from 'node:http';
import https from 'node:https';

// Node fetch has an independent ~300s response-header timeout. A normal-speed
// video plus optional ASR may legitimately take longer; use one explicit bound.
export function requestBrowserWatch(providerUrl, url, seconds) {
  const target = new URL(`${providerUrl}/bilibili-watch`);
  const data = JSON.stringify({ url, seconds: Math.max(2, Math.floor(seconds)) });
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, { method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
    } }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 100 * 1024 * 1024) { request.destroy(new Error('网页截图结果超过100MB')); return; }
        chunks.push(chunk);
      });
      response.on('error', error => { clearTimeout(timer); reject(error); });
      response.on('end', () => {
        clearTimeout(timer);
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200) throw new Error(body.error || `网页观看失败 HTTP ${response.statusCode}`);
          resolve(body);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('网页观看请求超过总等待时间')), (seconds + 190) * 1000);
    request.on('error', error => { clearTimeout(timer); reject(error); });
    request.end(data);
  });
}
