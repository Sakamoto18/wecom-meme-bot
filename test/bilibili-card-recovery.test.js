import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverBilibiliCard, normalizeBilibiliCard, createBilibiliCardRecovery } from '../src/bilibili-card-recovery.js';
import { QqBotService } from '../src/qq-service.js';
const bvid = 'BV1VbyxzsEpo';
const card = { title: '这严苛的训练几乎要了蛋的命!', preview: 'https://qq.ugcimg.cn/v1/cover' };
const author = '内松兔司';
function setup({ result, pages = [{}], changedTitle = false, rows } = {}) {
  const calls = [];
  const candidateSearch = async (title, uploader) => {
    assert.equal(title, card.title); assert.equal(uploader, author);
    return rows || [{ bvid, title: changedTitle ? 'different' : card.title, author,
      pages_count: pages.length, cover: 'https://i0.hdslb.com/cover.jpg' }];
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.ok(!url.includes('api.bilibili.com'));
    return new Response('image', { headers: { 'content-type': 'image/jpeg' } });
  };
  const chatClient = { isConfigured: true, complete: async (_h, blocks, options) => {
    if (options.usageSource === 'bilibili-card-uploader') return JSON.stringify({ author });
    assert.equal(blocks.filter(b => b.type === 'image_url').length, 2);
    assert.match(options.systemPrompt, /不得把候选author抄成visible_author/u);
    return result ?? JSON.stringify({ ambiguous: false, matches: [{ bvid, visible_author: author, cover_matches: true }] });
  } };
  return { calls, fetchImpl, chatClient, candidateSearch, cookieProvider: () => assert.fail('must not request account login') };
}
test('recovers only after matching title, visible uploader and cover; no provider or login calls during lookup', async () => {
  const options = setup();
  assert.equal((await recoverBilibiliCard(card, options)).url, 'https://www.bilibili.com/video/' + bvid);
  for (const { url, options: request } of options.calls) {
    assert.equal(request.redirect, 'error');
    assert.equal(Boolean(request.headers?.cookie), false);
  }
});
test('rejects unclear, invented, ambiguous or author-mismatched visual decisions', async () => {
  for (const result of ['not json', '{}', '{"matches":[]}',
    JSON.stringify({ ambiguous: true, matches: [{ bvid, visible_author: author, cover_matches: true }] }),
    JSON.stringify({ ambiguous: false, matches: [{ bvid: 'BV1DV5v6HELu', visible_author: author, cover_matches: true }] }),
    JSON.stringify({ ambiguous: false, matches: [{ bvid, visible_author: 'other', cover_matches: true }] }),
    JSON.stringify({ ambiguous: false, matches: [{ bvid, visible_author: author, cover_matches: false }] })]) {
    await assert.rejects(recoverBilibiliCard(card, setup({ result })));
  }
});
test('rejects approximate titles, changed metadata and unknown selected part', async () => {
  for (const options of [setup({ rows: [{ bvid, title: card.title + '合集' }] }),
    setup({ pages: [{}, {}] }), setup({ changedTitle: true })]) {
    options.chatClient.complete = (_h, _b, opt) => {
      assert.equal(opt.usageSource, 'bilibili-card-uploader'); return JSON.stringify({ author });
    };
    await assert.rejects(recoverBilibiliCard(card, options));
  }
});
test('input only accepts QQ card preview host and rejects oversized titles', () => {
  for (const preview of ['http://127.0.0.1/a', 'https://qq.ugcimg.cn.evil.test/a', 'https://user:pass@qq.ugcimg.cn/a']) {
    assert.equal(normalizeBilibiliCard({ ...card, preview }), null);
  }
  assert.equal(normalizeBilibiliCard({ ...card, title: 'x'.repeat(201) }), null);
});
test('official share feeds recovered URL into existing media path; exclusion and failures stay out of chat', async () => {
  let recovered = 0, downloads = 0;
  const resolver = { enabled: true,
    recoverBilibiliCard: async () => { recovered++; return { url: 'https://www.bilibili.com/video/' + bvid, bvid, provider: 'bilibili' }; },
    resolve: async candidate => { downloads++; assert.equal(candidate.provider, 'bilibili'); return { url: 'http://127.0.0.1:8787/media/test', title: card.title }; },
  };
  const input = { message_id: '1', message_type: 'group', group_id: 'g', user_id: 'u',
    bot_user_id: 'qqofficial:app:user:bot', media_share: true, bilibili_card: card, text: '[卡片消息] 小程序' };
  const service = new QqBotService({ mediaResolver: resolver, logger: { info() {}, warn() {} } });
  assert.equal((await service.handleMessage(input)).mode, 'media');
  assert.equal(downloads, 1);
  const excluded = new QqBotService({ mediaResolver: resolver, mediaExcludedGroups: ['g'], logger: { info() {}, warn() {} } });
  assert.equal((await excluded.handleMessage(input)).mode, 'media-excluded');
  assert.equal(recovered, 1);
  resolver.recoverBilibiliCard = async () => { throw new Error('ambiguous'); };
  assert.equal((await service.handleMessage({ ...input, message_id: '2' })).mode, 'media-unavailable');
  assert.equal(downloads, 1);
});

test('public search gets the uploader read from the card, without provider or login checks', async () => {
  const options = setup();
  let count = 0;
  options.candidateSearch = async (title, visibleAuthor) => {
    assert.equal(title, card.title); assert.equal(visibleAuthor, author);
    return [{ bvid, title, author, cover: 'https://i0.hdslb.com/cover.jpg', pages_count: 1 }];
  };
  options.chatClient.complete = async (_h, blocks, opts) => {
    count++;
    if (opts.usageSource === 'bilibili-card-uploader') return JSON.stringify({ author });
    assert.equal(blocks.filter(b => b.type === 'image_url').length, 2);
    return JSON.stringify({ ambiguous: false, matches: [{ bvid, visible_author: author, cover_matches: true }] });
  };
  assert.equal((await recoverBilibiliCard(card, options)).bvid, bvid);
  assert.equal(count, 2);
  assert.ok(options.calls.every(c => !c.url.startsWith('https://api.bilibili.com/')));
});


test('cross-group card cache shares work, recognizes identical previews at other URLs, expires and retries failures', async () => {
  let clock = 0, attempts = 0, imageRequests = 0, fail = false;
  const options = { fetchImpl: async url => {
    imageRequests++;
    return new Response(url.endsWith('/different') ? 'different picture' : 'same picture',
      { headers: { 'content-type': 'image/jpeg' } });
  } };
  const recover = createBilibiliCardRecovery({ ttlMs: 100, now: () => clock,
    recover: async () => { attempts++; if (fail) throw new Error('search unavailable'); return { bvid }; } });
  await Promise.all(['group-a', 'group-b', 'group-c'].map(() => recover(card, options)));
  assert.equal(attempts, 1); assert.equal(imageRequests, 1);
  await recover(card, options);
  assert.equal(attempts, 1); assert.equal(imageRequests, 1);
  await recover({ ...card, preview: 'https://qq.ugcimg.cn/v1/another-url' }, options);
  assert.equal(attempts, 1); assert.equal(imageRequests, 2);
  await recover({ ...card, preview: 'https://qq.ugcimg.cn/v1/different' }, options);
  assert.equal(attempts, 2); // same title is insufficient to reuse another image
  clock = 101; fail = true;
  await assert.rejects(recover(card, options));
  fail = false;
  await recover(card, options);
  assert.equal(attempts, 4);
});
