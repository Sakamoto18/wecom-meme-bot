import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemeCorpusStore } from '../src/meme-corpus.js';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'meme-corpus-test-'));
  const store = new MemeCorpusStore({
    databaseFilePath: path.join(directory, 'corpus.sqlite'),
    enabledCorpora: ['memewiki', 'cheer_terms', 'meme_style', 'ruozhiba'],
  });
  store.replaceCorpus('memewiki', [
    { id: 1, text: '【词条】尊嘟假嘟\n【用法】用来撒娇式质疑，意思是“真的假的”。' },
    { id: 2, text: '【词条】管人痴\n【用法】指过度沉迷虚拟主播的人。' },
  ], { sourceUrl: 'https://example.com/memewiki', license: 'MIT' });
  store.replaceCorpus('cheer_terms', [
    { id: 1, text: '【词条】半场开香槟\n【释义】指比赛还没结束就提前庆祝，最后被翻盘。' },
  ], { sourceUrl: 'https://example.com/cheer' });
  store.replaceCorpus('meme_style', [
    { id: 1, text: '对话：\n用户：老板又让周末加班\n回复：包的，不然领导又要记小本本了。' },
    { id: 2, text: '对话：\n用户：同事当面吹领导彩虹屁\n回复：666，舔都不舔了是吗？' },
  ], { sourceUrl: 'https://example.com/style' });
  store.replaceCorpus('vbar', [
    { id: 1, text: '【词条】V吧黑话\n【用法】只在虚拟主播话题里使用。' },
    { id: 2, text: '【词条】管人\n【用法】虚拟主播的观众称呼。' },
  ]);
  store.replaceCorpus('hell', [
    { id: 1, text: '地狱笑话：越周到越像在办黑活。' },
  ]);
  return { store, directory };
}

test('中文互联网语料按释义和风格分层检索', () => {
  const { store, directory } = fixture();
  try {
    assert.equal(store.isAvailable(), true);
    const definition = store.search('尊嘟假嘟是什么梗');
    assert.equal(definition[0].corpus, 'memewiki');
    assert.match(definition[0].text, /真的假的/);

    const style = store.search('老板周末加班怎么回');
    assert.ok(style.some((row) => row.corpus === 'meme_style'));
    const prompt = store.buildPrompt('老板周末加班怎么回');
    assert.match(prompt, /释义参考|接法示例/);
    assert.match(prompt, /记小本本/);
    assert.ok(prompt.length <= 1_000);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('默认不召回 V吧和地狱笑话，显式指定后才参与', () => {
  const { store, directory } = fixture();
  try {
    assert.equal(store.search('V吧黑话').some((row) => row.corpus === 'vbar'), false);
    assert.equal(store.search('V吧黑话', { corpora: ['vbar'] }).some((row) => row.corpus === 'vbar'), true);
    assert.equal(store.search('办黑活').some((row) => row.corpus === 'hell'), false);
    assert.equal(store.search('办黑活', { includeSensitive: true }).some((row) => row.corpus === 'hell'), true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('短中文词走词条回退，显式 V吧语料优先于通用梗库', () => {
  const { store, directory } = fixture();
  try {
    const vbarOnly = store.search('管人', { corpora: ['vbar'] });
    assert.equal(vbarOnly[0].corpus, 'vbar');
    assert.match(vbarOnly[0].terms, /管人/);

    const mixed = store.search('V吧黑话 管人', { corpora: ['memewiki', 'meme_style', 'vbar'] });
    assert.equal(mixed[0].corpus, 'vbar');
    const prompt = store.buildPrompt('V吧黑话 管人', {
      corpora: ['memewiki', 'meme_style', 'vbar'],
    });
    assert.match(prompt, /V吧黑话/);
    assert.doesNotMatch(prompt, /管人痴/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('重复导入替换同一语料库且不留下重复检索行', () => {
  const { store, directory } = fixture();
  try {
    assert.equal(store.getStats().meme_style, 2);
    store.replaceCorpus('meme_style', [
      { id: 1, text: '对话：\n用户：今天好困\n回复：我也快原地关机了。' },
    ]);
    assert.equal(store.getStats().meme_style, 1);
    assert.equal(store.search('原地关机').filter((row) => row.corpus === 'meme_style').length, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('空语料库不生成提示词', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'meme-corpus-empty-'));
  const store = new MemeCorpusStore({ databaseFilePath: path.join(directory, 'empty.sqlite') });
  try {
    assert.equal(store.buildPrompt('尊嘟假嘟'), '');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
