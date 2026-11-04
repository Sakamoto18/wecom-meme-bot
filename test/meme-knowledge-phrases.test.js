import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemeKnowledgeStore, memeKnowledgePrompt, memeReplyIntent } from '../src/meme-knowledge.js';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'meme-knowledge-'));
  const file = path.join(directory, 'knowledge.sqlite');
  let now = 1_800_000_000_000;
  const store = new MemeKnowledgeStore({ databaseFilePath: file, now: () => now });
  return {
    store, file,
    advance(ms) { now += ms; },
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

const tesEntry = {
  term: '滔博的大腿',
  aliases: ['滔博大腿', 'TES的大腿'],
  meaning: 'TES 胜利单曲里夸选手的一句歌词。',
  usage: ['夸人能 carry'],
  sourceDomains: ['bilibili.com'],
  sourceUrls: ['https://www.bilibili.com/video/BV1hznR6oETN'],
  confidence: 'high',
  lookupSource: 'video',
  lyrics: [{ line: '九妹九妹 滔博的大腿', position: '副歌' }, { line: '九妹九妹 上路的堡垒', position: '副歌' }],
  reception: { sentiment: 'positive', summary: '网友在刷副歌，夸 TES', phrases: ['九妹九妹'] },
  currentEvents: [{ subject: 'TES', event: '比赛', time: '2026-11-02', claim: '评论说 TES 赢了', verified: false, learnedAt: 1_800_000_000_000, expiresAt: 1_800_000_000_000 + 7 * 86_400_000 }],
  replyHooks: ['九妹九妹！'],
};

test('歌词片段能命中已学条目，单字和无关句子不会乱命中', () => {
  const f = fixture();
  try {
    assert.equal(f.store.put(tesEntry), true);
    const hit = f.store.lookupPhrase('九妹九妹 上路的堡垒');
    assert.equal(hit.term, '滔博的大腿');
    assert.equal(hit.matchType, 'lyric');
    assert.equal(hit.lyrics.length, 2);
    assert.equal(f.store.lookupPhrase('九妹九妹').term, '滔博的大腿');
    assert.equal(f.store.lookupPhrase('九'), null);
    assert.equal(f.store.lookupPhrase('妹妹今天吃什么'), null);
    assert.equal(f.store.lookupPhrase('今天天气不错'), null);
    // Plan §7.1: a two-character fragment alone is too short to count.
    assert.equal(f.store.lookupPhrase('滔博'), null);
    assert.equal(f.store.lookupPhrase('你就是滔博大腿').term, '滔博的大腿');
  } finally {
    f.close();
  }
});

test('旧库没有新列时自动迁移，原条目仍能读', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'meme-knowledge-old-'));
  const file = path.join(directory, 'old.sqlite');
  try {
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE meme_knowledge (
      term_key TEXT PRIMARY KEY, term TEXT NOT NULL, aliases_json TEXT NOT NULL, meaning TEXT NOT NULL,
      usage_json TEXT NOT NULL, source_domains_json TEXT NOT NULL, source_urls_json TEXT NOT NULL,
      confidence TEXT NOT NULL, lookup_source TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL)`);
    db.prepare(`INSERT INTO meme_knowledge VALUES ('似了','似了','[]','死了的谐音','[]','["bilibili.com"]','[]','high','wiki',1,1,9999999999999,1)`).run();
    db.close();
    const store = new MemeKnowledgeStore({ databaseFilePath: file });
    const old = store.lookup('似了');
    assert.equal(old.meaning, '死了的谐音');
    assert.deepEqual(old.lyrics, []);
    assert.deepEqual(old.reception, {});
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('提示词带上歌词、评论共识和未核实时事；7 天后不再当新消息，过期时事不再出现', () => {
  const prompt = memeKnowledgePrompt(tesEntry, 'cache', { intent: 'lyric', now: 1_800_000_000_000 });
  assert.match(prompt, /九妹九妹 滔博的大腿（副歌） \/ 九妹九妹 上路的堡垒/);
  assert.match(prompt, /评论区共识（网友怎么看，不是事实）：网友在刷副歌/);
  assert.match(prompt, /时事（2026-11-02，评论区在说，未核实）/);
  assert.match(prompt, /不知道下一句就直说“这版我就记到这句”/);
  assert.match(prompt, /不要编下一句歌词，不要编比赛结果/);
  const later = memeKnowledgePrompt(tesEntry, 'cache', { now: 1_800_000_000_000 + 8 * 86_400_000 });
  assert.doesNotMatch(later, /时事/);
});

test('回复意图：接歌词、评价、解释、默认', () => {
  assert.equal(memeReplyIntent('九妹九妹 上路的堡垒', { matchType: 'lyric' }), 'lyric');
  assert.equal(memeReplyIntent('下一句是啥', {}), 'lyric');
  assert.equal(memeReplyIntent('这歌怎么样', {}), 'evaluate');
  assert.equal(memeReplyIntent('这歌怎么样 滔博的大腿', { matchType: 'lyric' }), 'evaluate');
  assert.equal(memeReplyIntent('滔博的大腿是什么梗', {}), 'explain');
  assert.equal(memeReplyIntent('哈哈', {}), 'default');
});
