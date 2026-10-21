import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRelativeDatePrompt,
  extractRelativeDateFacts,
  relativeDateContradiction,
  repairRelativeDateAnswer,
} from '../src/relative-time.js';
import { generateConversationReply } from '../src/reply-engine.js';

const NOW = Date.parse('2026-10-21T12:00:00+08:00');
const QUESTION = '图片可见文字：三个月后人类将进入2027年。这是真的假的？';

test('相对时间按北京时间计算月末截断并输出目标年份', () => {
  assert.deepEqual(extractRelativeDateFacts(NOW, QUESTION), [{
    phrase: '三个月后',
    amount: 3,
    unit: 'month',
    sourceDate: '2026-10-21',
    targetDate: '2027-01-21',
    targetYear: 2027,
    targetMonth: 1,
  }]);
  assert.match(buildRelativeDatePrompt(NOW, QUESTION), /2027-01-21/);
  assert.match(buildRelativeDatePrompt(NOW, QUESTION), /目标年份是 2027/);
});

test('错误年份和“差着俩月”会被识别并本地修复', () => {
  const facts = extractRelativeDateFacts(NOW, QUESTION);
  const wrong = '假的，三个月后还是2027年1月，离进入2027年差着俩月。';
  assert.equal(relativeDateContradiction(wrong, facts), 'relative-date-contradiction');
  const repaired = repairRelativeDateAnswer(wrong, facts, NOW);
  assert.match(repaired, /2027-01-21/);
  assert.doesNotMatch(repaired, /差着俩月/);
});

test('生成回复会把相对时间纠错提示送入重写，并在最终发送前兜底', async () => {
  const calls = [];
  const result = await generateConversationReply({
    content: '真的假的',
    currentQuestion: QUESTION,
    modelInput: QUESTION,
    now: NOW,
    webSearchEnabled: false,
    chatClient: {
      isConfigured: true,
      async complete(_history, _input, options) {
        calls.push(options);
        if (calls.length === 1) {
          return '假的，三个月后还是2027年1月，离进入2027年差着俩月。';
        }
        return '按日历算，三个月后就是2027年1月，图里的说法字面成立。';
      },
    },
  });
  assert.match(calls[0].additionalSystemPrompt, /2027-01-21/);
  assert.match(calls[0].additionalSystemPrompt, /程序计算的相对时间/);
  assert.match(calls[1].revisionSystemPrompt, /相对时间纠错/);
  assert.match(result.answer, /2027/);
  assert.doesNotMatch(result.answer, /差着俩月/);
});

test('重写仍然算错时发送前本地修复', async () => {
  const result = await generateConversationReply({
    content: '真的假的',
    currentQuestion: QUESTION,
    modelInput: QUESTION,
    now: NOW,
    webSearchEnabled: false,
    chatClient: {
      isConfigured: true,
      async complete() {
        return '假的，还是2026年，离2027年差着俩月。';
      },
    },
  });
  assert.match(result.answer, /2027-01-21/);
  assert.doesNotMatch(result.answer, /差着俩月/);
  assert.equal(result.relativeDateCorrectionApplied, true);
});
