import test from 'node:test';
import assert from 'node:assert/strict';
import { requestsSourceDisplay, suppressUnrequestedSourceNotes } from '../src/source-display.js';

test('只按当前问题判断来源展示要求，不把后台检索当成展示许可', () => {
  for (const q of ['出处呢', '来源发我', '给我原文链接', '这句话谁说的']) assert.equal(requestsSourceDisplay(q), true, q);
  for (const q of ['如何评价中秋国庆请三休十三', '联网核实一下', '不要展示来源，给结论']) assert.equal(requestsSourceDisplay(q), false, q);
});

test('去掉截图中的媒体尾注，保留年假天数及所有实际括号说明', () => {
  const result = {context:'新京报、人民日报、example.com 的检索摘要'};
  const text = '请三天（3天年假）可以连休13天（新京报）。条件不明（需单位批准），按法定假期（2026年）计算（来源：example.com）。';
  assert.equal(suppressUnrequestedSourceNotes(text, '如何评价', result), '请三天（3天年假）可以连休13天。条件不明（需单位批准），按法定假期（2026年）计算。');
  assert.equal(suppressUnrequestedSourceNotes(text, '来源发我', result), text);
  assert.equal(suppressUnrequestedSourceNotes('这份报纸（新京报）是谁办的', '新京报是谁办的'), '这份报纸（新京报）是谁办的');
});
