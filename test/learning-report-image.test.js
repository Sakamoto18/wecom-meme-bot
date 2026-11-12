import test from 'node:test';
import assert from 'node:assert/strict';
import { createLearningReportRenderer, renderWebLearningResponse } from '../src/learning-report-image.js';
import { createSmileyPng } from '../src/png.js';

test('完整联网学习报告只发图片，保留全部正文给渲染器；进度和帮助仍发文字', async () => {
  const text = '联网学梗报告：测试\n结果：未入库\n来源：https://example.com\n报告编号：abc';
  const input = { mode: 'web-meme-learning-report', messages: [{ type: 'text', text }] };
  const result = await renderWebLearningResponse(input, async content => {
    assert.equal(content, text);return 'base64://' + createSmileyPng(8, 8).toString('base64');
  });
  assert.equal(result.messages.length, 1);assert.equal(result.messages[0].type, 'image');
  assert.ok(result.messages[0].base64.startsWith('iVBOR'));
  for (const value of ['学习进度：测试', '用法：/learn-meme']) {
    const short = { ...input, messages: [{ type: 'text', text: value }] };
    assert.equal(await renderWebLearningResponse(short, () => assert.fail('短消息不渲染')), short);
  }
  const ordinary = { ...input, mode: 'model' };
  assert.equal(await renderWebLearningResponse(ordinary, () => assert.fail('普通对话不渲染')), ordinary);
});

test('图片渲染失败给简短可恢复提示，不重发长文本', async () => {
  const result = await renderWebLearningResponse({ mode: 'web-meme-learning-report',
    messages: [{ type: 'text', text: '联网学梗报告：测试\nhttps://example.com' }] }, async () => { throw new Error('timeout'); });
  assert.match(result.messages[0].text, /生成失败/);
  assert.doesNotMatch(result.messages[0].text, /https:/);
});

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

test('封面卡片数据传入渲染器且参与缓存键', async () => {
  const bodies = [];
  const render = createLearningReportRenderer('http://provider', async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(createSmileyPng(8, 8));
  });
  await render('日报', [{ bvid: 'BV1W44w62ExZ', title: '黑猫鼓掌', status: 'failed' }]);
  await render('日报', [{ bvid: 'BV1W44w62ExZ', title: '黑猫鼓掌', status: 'learned' }]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].items[0].status, 'learned');
});
