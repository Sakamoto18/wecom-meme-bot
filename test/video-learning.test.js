import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { VideoLearningStore } from '../src/video-learning-store.js';
import { VideoLearningCoordinator, learningTopic } from '../src/video-learning.js';

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function fakeBilibili({ subtitles = true } = {}) {
  return async (url) => {
    const href = String(url);
    if (href.includes('/x/web-interface/nav')) {
      return jsonResponse({ code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } });
    }
    if (href.includes('/wbi/search/type') && href.includes('order=pubdate')) {
      return jsonResponse({ code: 0, data: { result: [
        { bvid: 'BV1EC4K6HEJn', title: '梗百科之“限定词冠军”是什么梗', play: 20328 },
        { bvid: 'BV1W44w62ExZ', title: '【梗百科】黑猫鼓掌是啥梗？', play: 230473 },
      ] } });
    }
    if (href.includes('/wbi/search/type')) {
      return jsonResponse({ code: 0, data: { result: [
        { bvid: 'BV1aa411c7xx', title: '<em>似了</em>是什么梗', description: '解说', duration: '0:18' },
        { bvid: 'BV1bb411c7yy', title: '似了 二创', description: '', duration: '1:05' },
      ] } });
    }
    if (href.includes('/x/player/wbi/v2')) {
      return jsonResponse({ code: 0, data: { subtitle: { subtitles: subtitles ? [{ lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/s.json' }] : [] } } });
    }
    if (href.includes('aisubtitle')) {
      return jsonResponse({ body: [{ from: 1, to: 3, content: '我似了' }, { from: 10, to: 12, content: '似了似了' }] });
    }
    throw new Error(`unexpected ${href}`);
  };
}

const screenshot = (await new Jimp({ width: 48, height: 27, color: 0xffcc00ff }).getBuffer('image/jpeg')).toString('base64');

function fixture(options = {}) {
  const fixtureOptions = options;
  const directory = mkdtempSync(path.join(tmpdir(), 'video-learning-'));
  let now = Date.UTC(2026, 10, 3, 10);
  const store = new VideoLearningStore({ databaseFilePath: path.join(directory, 'learning.sqlite'), now: () => now });
  const calls = [];
  const commands = [];
  const puts = [];
  const coordinator = new VideoLearningCoordinator({
    store,
    now: () => now,
    logger: { log() {}, warn() {} },
    fetchImpl: fakeBilibili(options),
    memeKnowledge: { put: (entry) => { puts.push(entry); return true; } },
    memeCorpus: options.memeCorpus ?? null,
    groupMemory: options.groupMemory ?? null,
    personaPrompt: () => '【全局人格】龙玉涛',
    ...(options.commentCollector ? { commentCollector: options.commentCollector } : {}),
    browserWatch: async (url, seconds) => {
      commands.push({ command: 'browser-screenshots', url, seconds });
      return {
        aid: options.aid ?? 0, bvid: url.split('/').pop(), cid: '7', page: 1,
        duration: 18, seconds: Math.min(18, seconds), startTime: 0, endTime: Math.min(18, seconds),
        title: '视频标题', description: '简介', sourceUrl: url,
        mode: 'browser-screenshots', audioObserved: false,
        frames: Array.from({ length: Math.min(18, seconds) }, (_, i) => ({ time: i, image: screenshot,
          caption: options.subtitles === false ? '' : (i === 1 ? '我似了' : i === 10 ? '似了似了' : '') })),
      };
    },
    chatClient: {
      async complete(_history, input, options) {
        calls.push({ input, options });
        if (options.usageSource === 'video-learning-watch') {
          return JSON.stringify({ events: '主角倒地说我似了', joke: '似了是死了的谐音', keep: ['倒地'], sound_dependent: false, uncertain: '' });
        }
        if (options.usageSource === 'video-learning-merge') {
          return options.mergeAnswer ?? JSON.stringify(options.failMerge
            ? { found: false, confidence: 'low' }
            : { found: true, term: '似了', aliases: ['我似了'], meaning: '“死了”的谐音，装可爱地表示崩溃或完蛋', origin: '', mechanism: '谐音', usage: ['遇到糟心事说一句我似了'], avoid: '', confidence: 'high', sound_unconfirmed: false, unconfirmed: '' });
        }
        if (options.usageSource === 'video-learning-comments') return fixtureOptions.commentAnswer ?? '';
        if (options.usageSource === 'video-learning-catchup-pick') return JSON.stringify({ memes: options.pickMemes ?? fixtureOptions.pickMemes ?? [] });
        if (options.usageSource === 'video-learning-catchup-browse') {
          return JSON.stringify({ memes: [
            { term: '黑猫鼓掌', bvid: 'BV1W44w62ExZ' },
            { term: '限定词冠军', bvid: 'BV1EC4K6HEJn' },
          ] });
        }
        return options.usageSource === 'video-learning-reply' ? '似了就是死了，你这都不知道你也快似了' : '';
      },
    },
  });
  return {
    store, coordinator, calls, commands, puts,
    advance(ms) { now += ms; },
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

const groupWaiter = { chatType: 'group', groupId: '913546080', userId: '1079175957', messageId: '123', conversationId: 'group:913546080' };

test('梗名从问句里取出核心词', () => {
  assert.equal(learningTopic('怎么似了？'), '似了');
  assert.equal(learningTopic('尊嘟假嘟是什么梗'), '尊嘟假嘟');
  assert.equal(learningTopic('wiki 哈基米'), '哈基米');
});

test('陌生梗先提醒并建任务，同群再问不重复提醒，别的群照常提醒', () => {
  const f = fixture();
  try {
    f.coordinator.tick = async () => {};
    assert.equal(f.coordinator.gate({ term: '似了', question: '怎么似了？', waiter: groupWaiter }).action, 'remind');
    assert.equal(f.coordinator.gate({ term: '似了', question: '似了啥意思', waiter: { ...groupWaiter, userId: '2', messageId: '124' } }).action, 'silent');
    assert.equal(f.coordinator.gate({ term: '似了', waiter: { ...groupWaiter, groupId: '239375116', messageId: '125' } }).action, 'remind');
    const task = f.store.findActiveTask('似了');
    assert.equal(task.metadata.waiters.length, 3);
    assert.equal(f.store.countTasksSince(0), 1);
  } finally {
    f.close();
  }
});

test('指定 B站链接时跳过梗百科搜索，直接看该链接并按视频里识别出的梗入库', async () => {
  const f = fixture();
  try {
    f.coordinator.tick = async () => {};
    f.coordinator.searchVideos = async () => { throw new Error('指定链接不应搜索梗百科'); };
    const watched = [];
    const originalWatch = f.coordinator.watchVideo.bind(f.coordinator);
    f.coordinator.watchVideo = (task, candidate, ...rest) => {
      watched.push([task.metadata.directLink, candidate.url, candidate.bvid]);
      return originalWatch(task, candidate, ...rest);
    };
    const queuedBy = f.coordinator.gate({
      term: '',
      question: '学一下这个视频',
      preferredUrl: 'https://www.bilibili.com/video/BV1aa411c7xx',
      preferredBvid: 'BV1aa411c7xx',
      directLink: true,
      waiter: groupWaiter,
    });
    assert.equal(queuedBy.action, 'remind');
    assert.equal(queuedBy.directLink, true);
    const second = f.coordinator.gate({
      term: '',
      question: '这个视频学一下',
      preferredUrl: 'https://www.bilibili.com/video/BV1aa411c7xx',
      preferredBvid: 'BV1aa411c7xx',
      directLink: true,
      waiter: { ...groupWaiter, messageId: '124' },
    });
    assert.equal(second.action, 'silent');

    const queued = f.store.nextQueuedTask();
    assert.equal(queued.metadata.directLink, true);
    await f.coordinator.processTask(queued);

    assert.deepEqual(watched, [[true, 'https://www.bilibili.com/video/BV1aa411c7xx', 'BV1aa411c7xx']]);
    const done = f.store.getTask(queued.taskKey);
    assert.equal(done.status, 'completed');
    assert.equal(done.result.entry.term, '似了');
    assert.equal(f.puts[0].term, '似了');
    assert.equal(f.puts[0].aliases.includes(done.topic), false);
    const watch = f.calls.find((call) => call.options.usageSource === 'video-learning-watch');
    assert.match(watch.input[0].text, /任务：从这个视频里找出最值得学的网络梗/);
    const merge = f.calls.find((call) => call.options.usageSource === 'video-learning-merge');
    assert.match(merge.options.systemPrompt, /用户直接指定了一个 B 站视频/);
  } finally {
    f.close();
  }
});

test('b23 短链没有 BV 时也按原链接直接观看', async () => {
  const f = fixture();
  try {
    f.coordinator.tick = async () => {};
    f.coordinator.searchVideos = async () => { throw new Error('指定链接不应搜索梗百科'); };
    const watched = [];
    const originalWatch = f.coordinator.watchVideo.bind(f.coordinator);
    f.coordinator.watchVideo = (task, candidate, ...rest) => {
      watched.push([task.metadata.directLink, candidate.url, candidate.bvid]);
      return originalWatch(task, candidate, ...rest);
    };
    f.coordinator.gate({
      term: '',
      question: '学一下这个视频',
      preferredUrl: 'https://b23.tv/AbCdEfG',
      preferredBvid: '',
      directLink: true,
      waiter: groupWaiter,
    });

    const queued = f.store.nextQueuedTask();
    assert.equal(queued.topic, 'B 站视频');
    assert.equal(queued.metadata.preferredUrl, 'https://b23.tv/AbCdEfG');
    await f.coordinator.processTask(queued);

    assert.deepEqual(watched, [[true, 'https://b23.tv/AbCdEfG', '']]);
    assert.equal(f.store.getTask(queued.taskKey).status, 'completed');
  } finally {
    f.close();
  }
});

test('检索已有准确证据、梗百科已收录或当天任务用完时不学习', () => {
  const f = fixture({
    memeCorpus: { search: () => [{ terms: '尊嘟假嘟', kind: 'definition' }] },
  });
  try {
    f.coordinator.tick = async () => {};
    assert.equal(f.coordinator.gate({ term: '某梗', evidenceQuality: 'exact-source', waiter: groupWaiter }), null);
    assert.equal(f.coordinator.gate({ term: '尊嘟假嘟', waiter: groupWaiter }), null);
    f.coordinator.limits.dailyTasks = 1;
    assert.equal(f.coordinator.gate({ term: '新梗一', waiter: groupWaiter }).action, 'remind');
    assert.equal(f.coordinator.gate({ term: '新梗二', waiter: groupWaiter }), null);
  } finally {
    f.close();
  }
});

test('看视频：1 秒一帧拼网格、读字幕、分段分析后入梗库，并给每个提问人排队回复', async () => {
  const f = fixture();
  try {
    f.coordinator.tick = async () => {};
    f.coordinator.gate({ term: '似了', question: '怎么似了？', waiter: groupWaiter });
    f.coordinator.gate({ term: '似了', question: '似了？', waiter: { chatType: 'private', userId: '555', messageId: '9' } });
    await f.coordinator.processTask(f.store.nextQueuedTask());

    assert.ok(f.commands.every(item => item.command === 'browser-screenshots'));

    const watch = f.calls.filter((call) => call.options.usageSource === 'video-learning-watch');
    assert.ok(watch.length >= 1);
    assert.ok(watch[0].input.filter((block) => block.type === 'image_url').length >= 1);
    assert.match(watch[0].input[0].text, /网页可见字幕：\n\[00:01\] 我似了/);

    const task = f.store.findLatestTask('似了', 'completed');
    assert.equal(task.result.found, true);
    assert.equal(task.result.sources.length, 2);
    assert.equal(f.puts[0].lookupSource, 'video');
    assert.equal(f.coordinator.knowledgeFor('似了').term, '似了');
    assert.equal(f.coordinator.gate({ term: '似了', waiter: groupWaiter }).action, 'use');

    const deliveries = f.store.claimDeliveries(10);
    assert.deepEqual(deliveries.map((item) => [item.kind, item.payload.chatType, item.payload.messageId]).sort(), [
      ['result', 'group', '123'],
      ['result', 'private', '9'],
    ]);
    assert.match(deliveries[0].payload.text, /似了/);
    const reply = f.calls.find((call) => call.options.usageSource === 'video-learning-reply');
    assert.equal(reply.options.prioritySystemPrompt, '【全局人格】龙玉涛');
  } finally {
    f.close();
  }
});

test('没有字幕时只观察画面，不下载音频；看完仍说不清就记失败、回复没查到并冷却 24 小时', async () => {
  const f = fixture({ subtitles: false, asr: { command: 'python', args: ['asr.py'] } });
  try {
    f.coordinator.tick = async () => {};
    const originalComplete = f.coordinator.chatClient.complete;
    f.coordinator.chatClient.complete = (history, input, options) => originalComplete(history, input, { ...options, failMerge: true });
    f.coordinator.gate({ term: '怪梗', question: '怪梗啥意思', waiter: groupWaiter });
    await f.coordinator.processTask(f.store.nextQueuedTask());

    assert.ok(f.commands.every(item => item.command === 'browser-screenshots'));
    const watch = f.calls.find((call) => call.options.usageSource === 'video-learning-watch');
    assert.match(watch.input[0].text, /本段没有可读取的网页字幕/);
    assert.ok(f.store.findLatestTask('怪梗', 'failed'));
    assert.equal(f.puts.length, 0);
    assert.equal(f.store.claimDeliveries(10)[0].kind, 'failure');
    assert.equal(f.coordinator.gate({ term: '怪梗', waiter: groupWaiter }), null);
    f.advance(25 * 60 * 60 * 1000);
    assert.equal(f.coordinator.gate({ term: '怪梗', waiter: groupWaiter }).action, 'remind');
  } finally {
    f.close();
  }
});

test('重启后把进行中的任务放回队列', () => {
  const f = fixture();
  try {
    const { task } = f.store.createOrJoinTask({ topic: '中断梗' });
    f.store.updateTask(task.taskKey, { status: 'watching' });
    assert.equal(f.store.requeueInterrupted(), 1);
    assert.equal(f.store.nextQueuedTask().taskKey, task.taskKey);
  } finally {
    f.close();
  }
});


function groupMemoryWith(rows) {
  return {
    ensureOpen: () => ({
      prepare: () => ({ all: () => rows }),
    }),
  };
}

test('每日补课：03:00 后从群聊挑反复出现的陌生梗去学，结果只写梗库和日报，不发群消息', async () => {
  const f = fixture({
    groupMemory: groupMemoryWith([
      { userId: 'a', text: '我似了' }, { userId: 'b', text: '似了似了' }, { userId: 'c', text: '今天吃啥' },
    ]),
    pickMemes: [
      { term: '似了', count: 2, speakers: 2 },
      { term: '只说过一次', count: 1, speakers: 1 },
    ],
  });
  try {
    f.coordinator.limits.dailyCatchupTasks = 1;
    f.advance(-16 * 60 * 60 * 1000); // fixture starts at 18:00 Beijing; now 02:00
    assert.equal(f.coordinator.catchupDue(), '');
    f.advance(2 * 60 * 60 * 1000); // 04:00 Beijing time
    const day = f.coordinator.catchupDue();
    assert.equal(day, '2026-11-03');
    const run = await f.coordinator.runCatchup(day);
    assert.equal(run.status, 'done');
    assert.deepEqual(run.items.map((item) => [item.term, item.source, item.status]), [['似了', 'group', 'learned']]);
    assert.equal(f.puts[0].term, '似了');
    assert.equal(f.store.claimDeliveries(10).length, 0);
    assert.equal(f.coordinator.catchupDue(), '');
    assert.equal(f.coordinator.catchupReport(run.startedAt - 1, run.startedAt + 1).day, day);
  } finally {
    f.close();
  }
});

test('群聊没有能学的梗时，主动去翻 B 站梗百科，先看带出这个梗的那条视频', async () => {
  const f = fixture({ groupMemory: groupMemoryWith([]), pickMemes: [] });
  try {
    f.coordinator.limits.dailyCatchupTasks = 2;
    const watched = [];
    const originalWatch = f.coordinator.watchVideo.bind(f.coordinator);
    f.coordinator.watchVideo = (task, candidate, ...rest) => {
      watched.push([task.topic, candidate.bvid]);
      return originalWatch(task, candidate, ...rest);
    };
    const run = await f.coordinator.runCatchup('2026-11-03');
    assert.deepEqual(run.items.map((item) => [item.term, item.source]), [['黑猫鼓掌', 'bilibili'], ['限定词冠军', 'bilibili']]);
    assert.deepEqual(watched.filter(([, bvid]) => bvid === 'BV1W44w62ExZ'), [['黑猫鼓掌', 'BV1W44w62ExZ']]);
    assert.equal(watched.find(([topic]) => topic === '黑猫鼓掌')[1], 'BV1W44w62ExZ');
  } finally {
    f.close();
  }
});

test('每日补课受 10 分钟素材上限约束', async () => {
  const f = fixture({ groupMemory: groupMemoryWith([]), pickMemes: [] });
  try {
    f.coordinator.limits.dailyCatchupTasks = 3;
    f.coordinator.limits.dailyCatchupSeconds = 30;
    const run = await f.coordinator.runCatchup('2026-11-03');
    assert.equal(run.items.length, 1);
    assert.ok(run.items[0].seconds <= 30);
  } finally {
    f.close();
  }
});


test('视频里根本没出现这个词时不入梗库，记为内容对不上', async () => {
  const f = fixture();
  try {
    f.coordinator.tick = async () => {};
    f.coordinator.gate({ term: '耳朵龙', question: '耳朵龙啥意思', waiter: groupWaiter });
    await f.coordinator.processTask(f.store.nextQueuedTask());
    const task = f.store.findLatestTask('耳朵龙', 'failed');
    assert.equal(task.error, '视频里没出现这个词');
    assert.equal(f.puts.length, 0);
    assert.equal(f.coordinator.knowledgeFor('耳朵龙'), null);
  } finally {
    f.close();
  }
});

test('后台学来源视频：不提醒、不排队回复，只把结果写进梗库', async () => {
  const f = fixture();
  try {
    f.coordinator.tick = async () => {};
    const first = f.coordinator.gate({ term: '似了', background: true, preferredBvid: 'BV1aa411c7xx', waiter: groupWaiter });
    assert.equal(first.action, 'background');
    assert.equal(f.coordinator.gate({ term: '似了', background: true, waiter: groupWaiter }).taskKey, first.taskKey);
    const task = f.store.nextQueuedTask();
    assert.equal(task.metadata.preferredBvid, 'BV1aa411c7xx');
    assert.equal(task.metadata.waiters.length, 0);
    await f.coordinator.processTask(task);
    assert.equal(f.store.findLatestTask('似了', 'completed').result.found, true);
    assert.equal(f.puts.length, 1);
    assert.equal(f.store.claimDeliveries(10).length, 0);
  } finally {
    f.close();
  }
});


function fakeComments(texts) {
  return texts.map((text, index) => ({
    commentId: String(index + 1), parentId: '', text, likeCount: 40 - index, replyCount: 0,
    publishedAt: 0, authorHash: `a${index}`, sort: 'hot', rank: index + 1,
  }));
}

test('学视频时同时抓评论区：歌词、评论共识、未核实时事写进梗条目，评论原文入库但不带昵称', async () => {
  const collects = [];
  const f = fixture({
    aid: 117506832404912,
    commentCollector: {
      collect: async (aid, options) => {
        collects.push({ aid, ...options });
        return { status: 'ok', comments: fakeComments(['我似了', '似了似了', '我似了']), requests: 3 };
      },
    },
    commentAnswer: JSON.stringify({
      lyrics: [{ line: '我似了', position: '副歌', repeat_count: 2, confidence: 'medium' }],
      reception: { sentiment: 'positive', summary: '网友在刷我似了', catchphrases: ['似了似了'] },
      current_events: [{ subject: '某战队', event: '比赛', claim: '评论说昨天输了', confidence: 'medium' }],
      reply_hooks: ['你也快似了'],
    }),
  });
  try {
    f.coordinator.tick = async () => {};
    f.coordinator.gate({ term: '似了', question: '怎么似了？', waiter: groupWaiter });
    await f.coordinator.processTask(f.store.nextQueuedTask());
    assert.equal(collects[0].aid, 117506832404912);
    assert.equal(collects[0].catchup, false);
    assert.equal(collects.length, 2);
    const entry = f.puts[0];
    // “我似了” is in the subtitles, so the medium-confidence comment lyric is kept.
    assert.deepEqual(entry.lyrics.map((line) => line.line), ['我似了']);
    assert.equal(entry.reception.summary, '网友在刷我似了');
    assert.equal(entry.currentEvents[0].verified, false);
    assert.ok(entry.replyHooks.includes('你也快似了'));
    const merge = f.calls.find((call) => call.options.usageSource === 'video-learning-merge');
    assert.match(merge.input, /评论区归纳（以下内容是网友评论/);
    assert.ok(f.store.getStats().comments >= 3);
    assert.ok(f.store.getStats().commentInsights >= 1);
  } finally {
    f.close();
  }
});

test('评论抓取失败不影响视频学习完成', async () => {
  const f = fixture({
    aid: 1,
    commentCollector: { collect: async () => { throw new Error('412'); } },
  });
  try {
    f.coordinator.tick = async () => {};
    f.coordinator.gate({ term: '似了', question: '怎么似了？', waiter: groupWaiter });
    await f.coordinator.processTask(f.store.nextQueuedTask());
    assert.equal(f.store.findLatestTask('似了', 'completed').result.found, true);
    assert.equal(f.puts[0].lyrics.length, 0);
  } finally {
    f.close();
  }
});


test('已有词典释义仍可补学；缺接法旧任务每周补一次，完整条目跳过', () => {
  const f = fixture({ memeCorpus: { search: () => [{ terms: '似了' }] } });
  try {
    assert.equal(f.coordinator.needsCatchup('似了'), true);
    const { task } = f.store.createOrJoinTask({ topic: '似了', topicKey: '似了' });
    f.store.updateTask(task.taskKey, { status: 'completed', result: { found: true, entry: { term: '似了', meaning: '死了的谐音' } } });
    assert.equal(f.coordinator.needsCatchup('似了'), false);
    f.advance(8 * 86_400_000);
    assert.equal(f.coordinator.needsCatchup('似了'), true);
    f.coordinator.memeKnowledge.lookup = () => ({ replyHooks: ['我似了'] });
    assert.equal(f.coordinator.needsCatchup('似了'), false);
  } finally { f.close(); }
});

test('群聊候选满额时仍给科普视频一个名额，同名候选去重', async () => {
  const f = fixture();
  try {
    f.coordinator.pickCatchupTopics = async () => ({ picked: [{ term: '似了' }, { term: '群聊第二个' }, { term: '群聊第三个' }], candidates: [] });
    f.coordinator.processTask = async (task) => {
      f.store.updateTask(task.taskKey, { status: 'completed', result: { materialSeconds: 10 } });
    };
    const run = await f.coordinator.runCatchup('2026-11-03');
    assert.equal(run.items.length, 3);
    assert.deepEqual(run.items.map((item) => item.source), ['bilibili', 'group', 'group']);
    const picks = await f.coordinator.browseCatchupTopics(2, [{ term: '黑猫鼓掌' }]);
    assert.deepEqual(picks.map((item) => item.term), ['限定词冠军']);
  } finally { f.close(); }
});

test('群聊选题失败仍能自动发现视频；每日总任务预算也约束补课', async () => {
  const f = fixture();
  try {
    f.coordinator.pickCatchupTopics = async () => { throw new Error('picker unavailable'); };
    f.coordinator.limits.dailyTasks = 1;
    const run = await f.coordinator.runCatchup('2026-11-03');
    assert.equal(run.items.length, 1);
    assert.equal(run.items[0].source, 'bilibili');
  } finally { f.close(); }
});


test('视频发现失败会将保留名额还给群聊；不会丢掉已选候选', async () => {
  const f = fixture();
  try {
    f.coordinator.pickCatchupTopics = async () => ({ picked: [{ term: '甲梗' }, { term: '乙梗' }, { term: '丙梗' }], candidates: [] });
    f.coordinator.browseCatchupTopics = async () => { throw new Error('browse unavailable'); };
    f.coordinator.processTask = async (task) => {
      f.store.updateTask(task.taskKey, { status: 'completed', result: { materialSeconds: 10 } });
    };
    const run = await f.coordinator.runCatchup('2026-11-03');
    assert.deepEqual(run.items.map((item) => item.term), ['甲梗', '乙梗', '丙梗']);
  } finally { f.close(); }
});


test('视频学习把关系机制写入全局联想库，供新场景迁移使用', async () => {
  const f = fixture();
  try {
    const associations = [];
    f.coordinator.memeKnowledge.putAssociation = (entry) => { associations.push(entry); return true; };
    f.coordinator.tick = async () => {};
    f.coordinator.gate({ term: '似了', question: '似了是什么梗', waiter: groupWaiter });
    await f.coordinator.processTask(f.store.nextQueuedTask());
    assert.equal(associations.length, 1);
    assert.equal(associations[0].target, '似了');
    assert.equal(associations[0].mechanism, '谐音');
    assert.match(associations[0].trigger, /遇到糟心事/);
    assert.ok(associations[0].sourceUrls.length > 0);
  } finally { f.close(); }
});

test('网页播放失败保留原因，不回退媒体下载，也不写入知识', async () => {
  const f = fixture();
  try {
    f.coordinator.tick = async () => {};
    f.coordinator.browserWatch = async () => { throw new Error('网页播放器超过15秒未前进'); };
    f.coordinator.gate({ term: '似了', waiter: groupWaiter });
    await f.coordinator.processTask(f.store.nextQueuedTask());
    assert.match(f.store.findLatestTask('似了', 'failed').error, /超过15秒未前进/);
    assert.equal(f.puts.length, 0);
    assert.equal(f.calls.some(call => call.options.usageSource === 'video-learning-watch'), false);
  } finally { f.close(); }
});

test('没有网页provider配置时失败，不调用媒体解析下载', async () => {
  let requested = false;
  const coordinator = new VideoLearningCoordinator({ fetchImpl: async () => { requested = true; } });
  await assert.rejects(coordinator.browserWatch('https://www.bilibili.com/video/BV1Epx96EEBG', 3), /禁止回退下载/);
  assert.equal(requested, false);
});

test('音频转写成功纳入观察，失败仍学习画面并记录未学习音频', async () => {
  for (const state of ['transcribed', 'partial', 'unavailable']) {
    const success = state !== 'unavailable';
    const f = fixture();
    try {
      f.coordinator.tick = async () => {};
      const original = f.coordinator.browserWatch;
      f.coordinator.browserWatch = async (...args) => ({ ...await original(...args), audio: success
        ? { status: state, error: state === 'partial' ? '仅学习部分音频：转写到 3/18 秒' : '', transcript: [{start: 1, end: 3, text: '我似了'}] }
        : {status: 'unavailable', error: '本次未学习音频：音频获取失败'} });
      f.coordinator.gate({ term: '似了', waiter: groupWaiter });
      await f.coordinator.processTask(f.store.nextQueuedTask());
      const result = f.store.findLatestTask('似了', 'completed').result;
      assert.match(result.sources[0].audioStatus, state === 'partial' ? /仅学习部分音频/ : success ? /已学习网页音频转写/ : /本次未学习音频/);
      const watch = f.calls.find(call => call.options.usageSource === 'video-learning-watch');
      assert.match(watch.input[0].text, success ? /网页音频转写（可能有错字）/ : /本次未学习音频/);
    } finally { f.close(); }
  }
});


test('中置信视频保留候选记忆，排除未核实出处和原句', async () => {
  const f = fixture();
  try {
    f.coordinator.mergeKnowledge = async () => ({ found: true, term: '似了', aliases: ['我似了'],
      confidence: 'medium', meaning: '谐音表示崩溃', origin: '未经核实的来源', mechanism: '死与似的谐音',
      usage: ['倒霉时自嘲'], lyrics: [{ line: '未经核实原句', confidence: 'high' }], replyHooks: ['评论套话'],
      uncertainties: ['出处待查'], unconfirmed: '出处待查' });
    const candidates = [];
    f.coordinator.memeKnowledge.putCandidate = entry => { candidates.push(entry); return true; };
    f.coordinator.tick = async () => {};
    f.coordinator.gate({ term: '似了', waiter: groupWaiter });
    await f.coordinator.processTask(f.store.nextQueuedTask());
    assert.equal(f.puts.length, 0);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].confidence, 'medium');
    assert.equal(candidates[0].verified, false);
    assert.doesNotMatch(candidates[0].meaning, /未经核实的来源/);
    assert.deepEqual(candidates[0].lyrics, []);
    assert.deepEqual(candidates[0].replyHooks, []);
  } finally { f.close(); }
});

test('观看空位繁忙有界延后，保留原任务不发送虚假学习失败', async () => {
  const f = fixture();
  try {
    const { task } = f.store.createOrJoinTask({ topic: '等候观看', metadata: {
      background: true, directLink: true, preferredBvid: 'BV1Epx96EEBG', waiters: [] } });
    let attempts = 0;
    f.coordinator.browserWatch = async () => { attempts++;throw Object.assign(new Error('观看服务忙'), { code: 'WATCH_BUSY' }); };
    await f.coordinator.processTask(task);
    let queued = f.store.getTask(task.taskKey);
    assert.equal(queued.status, 'queued');assert.equal(f.store.nextQueuedTask(), null);
    await f.coordinator.processTask(queued);assert.equal(attempts, 1);
    for (let i = 0; i < 3; i++) { f.advance(60001);await f.coordinator.processTask(f.store.getTask(task.taskKey)); }
    assert.equal(f.store.getTask(task.taskKey).status, 'failed');assert.equal(attempts, 4);
    assert.equal(f.store.claimDeliveries().length, 0);
  } finally { f.close(); }
});
