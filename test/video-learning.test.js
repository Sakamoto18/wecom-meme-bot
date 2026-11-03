import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
    asr: options.asr ?? null,
    resolveMedia: async (url) => ({
      bvid: url.split('/').pop(),
      cid: '7',
      page: 1,
      duration: 18,
      title: '视频标题',
      description: '简介',
      sourceUrl: url,
      mediaUrl: 'https://upos.example/video.mp4',
      requestHeaders: { referer: 'https://www.bilibili.com/' },
    }),
    runCommand: async (command, args) => {
      commands.push({ command, args });
      if (command === 'ffmpeg') {
        const tilePattern = args.find((arg) => arg.endsWith('tile_%03d.jpg'));
        writeFileSync(tilePattern.replace('%03d', '001'), 'jpg1');
        writeFileSync(tilePattern.replace('%03d', '002'), 'jpg2');
        return '';
      }
      return JSON.stringify([{ start: 0, end: 4, text: '转写的话' }]);
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

    const ffmpeg = f.commands.find((item) => item.command === 'ffmpeg');
    assert.ok(ffmpeg.args.includes('fps=1,scale=320:-2,tile=3x3'));
    assert.ok(ffmpeg.args.includes('-headers'));
    assert.equal(f.commands.some((item) => item.command !== 'ffmpeg'), false);

    const watch = f.calls.filter((call) => call.options.usageSource === 'video-learning-watch');
    assert.ok(watch.length >= 1);
    assert.ok(watch[0].input.filter((block) => block.type === 'image_url').length >= 1);
    assert.match(watch[0].input[0].text, /B 站字幕：\n\[00:01\] 我似了/);

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

test('没有字幕时用本地语音识别；看完仍说不清就记失败、回复没查到并冷却 24 小时', async () => {
  const f = fixture({ subtitles: false, asr: { command: 'python', args: ['asr.py'] } });
  try {
    f.coordinator.tick = async () => {};
    const originalComplete = f.coordinator.chatClient.complete;
    f.coordinator.chatClient.complete = (history, input, options) => originalComplete(history, input, { ...options, failMerge: true });
    f.coordinator.gate({ term: '怪梗', question: '怪梗啥意思', waiter: groupWaiter });
    await f.coordinator.processTask(f.store.nextQueuedTask());

    assert.ok(f.commands.some((item) => item.command === 'python'));
    const watch = f.calls.find((call) => call.options.usageSource === 'video-learning-watch');
    assert.match(watch.input[0].text, /语音转写（可能有错字）/);
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
