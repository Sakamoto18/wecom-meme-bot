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
    { id: 3, text: '【词条】头顶尖尖的\n【用法】“脑袋尖尖的”可用来调侃逻辑怪异、言论难懂。' },
  ], { sourceUrl: 'https://example.com/memewiki', license: 'MIT' });
  store.replaceCorpus('cheer_terms', [
    { id: 1, text: '【词条】半场开香槟\n【释义】指比赛还没结束就提前庆祝，最后被翻盘。' },
  ], { sourceUrl: 'https://example.com/cheer' });
  store.replaceCorpus('meme_style', [
    { id: 1, text: '对话：\n用户：老板又让周末加班\n回复：包的，不然领导又要记小本本了。' },
    { id: 2, text: '对话：\n用户：同事当面吹领导彩虹屁\n回复：666，舔都不舔了是吗？' },
  ], { sourceUrl: 'https://example.com/style' });
  store.replaceCorpus('have_meme', [
    {
      id: 1,
      text: '表达参考：知识已经打包，但你的大脑不会握手。',
      terms: '知识 大脑 握手',
      metadata: { sourceKind: 'have-meme', kind: 'joke' },
    },
  ], { sourceUrl: 'https://example.com/have-meme' });
  store.replaceCorpus('ptt_style', [
    {
      id: 1,
      text: '对话：\n用户：这工作也太难了吧\n回复：哪份工作不难，你问最不难的比较快。',
      terms: '工作 太难',
      metadata: { sourceKind: 'ptt-gossiping' },
    },
  ], { sourceUrl: 'https://example.com/ptt' });
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
    assert.match(prompt, /角色人格与安全规则 > 当前问题与检索事实 > 本语料参考/);
    assert.ok(prompt.length <= 1_000);

    const styleOnly = store.buildPrompt('老板周末加班', { styleOnly: true });
    assert.doesNotMatch(styleOnly, /释义参考/);
    assert.match(styleOnly, /接法示例/);
    const definitionQueryWithoutDefinitions = store.buildPrompt('尊嘟假嘟是什么梗', { styleOnly: true });
    assert.doesNotMatch(definitionQueryWithoutDefinitions, /释义参考/);
    assert.equal(definitionQueryWithoutDefinitions, '');
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

test('have-meme 和 PTT 样本保留来源元数据且可按当前内容召回', () => {
  const { store, directory } = fixture();
  try {
    const haveMeme = store.search('知识 大脑 握手', { corpora: ['have_meme'] });
    assert.equal(haveMeme[0].metadata.sourceKind, 'have-meme');
    const ptt = store.search('工作 太难', { corpora: ['ptt_style'] });
    assert.equal(ptt[0].metadata.sourceKind, 'ptt-gossiping');
    assert.match(store.buildPrompt('工作太难怎么办', {
      corpora: ['ptt_style'],
      styleOnly: true,
    }), /PTT 群聊风格/);
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

test('普通闲聊没有贴题命中时不强行注入随机语感样本', () => {
  const { store, directory } = fixture();
  try {
    const prompt = store.buildPrompt('你好', { styleOnly: true });
    assert.equal(prompt, '');
    const explicitFallback = store.buildPrompt('你好', {
      styleOnly: true,
      allowStyleFallback: true,
    });
    assert.match(explicitFallback, /中文互联网语料语感参考/);
    assert.match(explicitFallback, /通用接法/);
    assert.match(explicitFallback, /只当通用群聊节奏锚点/);
    assert.doesNotMatch(prompt, /释义参考/);

    assert.equal(store.buildPrompt('你好', {
      styleOnly: true,
      allowStyleFallback: false,
    }), '');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('普通聊天按短语重合命中梗的近似说法，不要求逐字相同', () => {
  const { store, directory } = fixture();
  try {
    for (const query of ['你脑袋怎么尖尖的啊', '为什么你的脑袋是尖尖的']) {
      const prompt = store.buildPrompt(query, {
        styleOnly: true,
        autoDefinition: true,
      });
      assert.match(prompt, /释义参考/, query);
      assert.match(prompt, /头顶尖尖的/, query);
    }

    for (const query of ['尖尖的东西怎么画', '老板周末加班怎么回']) {
      const prompt = store.buildPrompt(query, {
        styleOnly: true,
        autoDefinition: true,
      });
      assert.doesNotMatch(prompt, /释义参考/, query);
    }

    assert.doesNotMatch(store.buildPrompt('你脑袋怎么尖尖的啊', {
      styleOnly: true,
    }), /释义参考/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
