import test from 'node:test';
import assert from 'node:assert/strict';
import { createLearningReportRenderer } from '../src/learning-report-image.js';
import { createSmileyPng } from '../src/png.js';

test('整张报告按正文缓存，两个接收人共用图片', async () => {
  let calls = 0;
  const render = createLearningReportRenderer('http://provider/resolve', async (url, options) => {
    calls++;
    assert.equal(url, 'http://provider/learning-report.png');
    assert.equal(JSON.parse(options.body).text, '中文报告\n下一行');
    return new Response(createSmileyPng(8, 8));
  });
  const [one, two] = await Promise.all([render('中文报告\n下一行'), render('中文报告\n下一行')]);
  assert.equal(one, two);
  assert.match(one, /^base64:\/\/iVBOR/);
  assert.equal(calls, 1);
});

test('图片失败不缓存错误，下次投递可重试', async () => {
  let calls = 0;
  const render = createLearningReportRenderer('http://provider', async () => ++calls === 1
    ? new Response('failed', {status: 502}) : new Response(createSmileyPng(8, 8)));
  await assert.rejects(render('报告'), /HTTP 502/);
  assert.match(await render('报告'), /^base64:/);
  assert.equal(calls, 2);
});
