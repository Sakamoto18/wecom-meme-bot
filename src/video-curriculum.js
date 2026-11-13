const dayKey = now => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);

// A durable per-author queue. A page is saved before any video is watched;
// every task result and report survive a process restart independently.
export class VideoCurriculum {
  constructor(coordinator, options = {}) {
    this.coordinator = coordinator;
    this.store = coordinator.store;
    this.mid = String(options.mid ?? '').trim();
    this.recipients = [...(options.recipients ?? [])].filter(id => /^\d+$/u.test(id));
    this.dailyVideos = Math.max(1, Math.min(10, Number(options.dailyVideos) || 10));
    this.dailySeconds = Math.max(60, Math.min(3600, Number(options.dailySeconds) || 3000));
    this.hour = Math.max(0, Math.min(23, Number(options.hour ?? 3)));
    this.key = `bilibili-space:${this.mid}`;
  }

  get enabled() { return /^\d+$/u.test(this.mid) && this.recipients.length > 0; }

  async page(pn) {
    const c = this.coordinator;
    const headers = await c.bilibiliHeaders({
      referer: `https://space.bilibili.com/${this.mid}`,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    }, { requireSession: true });
    const url = await c.wbiUrl('https://api.bilibili.com/x/space/wbi/arc/search', {
      mid: this.mid, pn, ps: 30, order: 'pubdate', platform: 'web',
    }, headers);
    const body = await c.getJson(url, headers);
    if (!Array.isArray(body?.data?.list?.vlist)) throw new Error('主页没有返回视频列表');
    return { total: Number(body.data.page?.count) || 0, videos: body.data.list.vlist
      .filter(v => /^BV[0-9A-Za-z]{10}$/u.test(v.bvid))
      .map(v => ({ bvid: v.bvid, title: String(v.title ?? v.bvid).slice(0, 160) })) };
  }

  async tick() {
    if (!this.enabled) return;
    const c = this.coordinator;
    const now = c.now();
    if (new Date(now + 8 * 3600_000).getUTCHours() < this.hour) return;
    const state = this.store.getProgress(this.key) ?? {
      queue: [], seen: [], nextPage: 1, learned: 0, failed: 0, total: 0,
    };
    const save = () => this.store.saveProgress(this.key, state);
    if (state.run?.status === 'done') this.report(state);
    const today = dayKey(now);
    if (state.run?.day === today && state.run.status === 'done') return;
    if (state.run?.day === today && state.run.status === 'retry-wait' && now < state.run.retryAt) return;
    if (state.run?.day !== today) {
      // Report an interrupted previous day, then continue its persisted queue.
      if (state.run) { state.run.status = 'interrupted'; this.report(state); }
      state.run = { day: today, startedAt: now, status: 'running', items: [], seconds: 0 };
      save();
    }
    const run = state.run;
    run.status = 'running';
    delete run.error;
    delete run.retryAt;
    const videoLimit = Math.min(this.dailyVideos, Math.max(1, Number(run.videoLimit) || this.dailyVideos));
    try {
      while (run.items.length < videoLimit && run.seconds < this.dailySeconds - 20) {
        if (!state.queue.length) {
          // At most three pages per day; duplicate BV IDs never become work.
          if ((run.pages ?? 0) >= 3) break;
          const page = await this.page(state.nextPage);
          run.pages = (run.pages ?? 0) + 1;
          state.total = page.total;
          state.queue.push(...page.videos.filter(v => !state.seen.includes(v.bvid)));
          const lastPage = Math.max(1, Math.ceil(page.total / 30));
          state.nextPage = state.nextPage >= lastPage ? 1 : state.nextPage + 1;
          save();
          if (!state.queue.length && state.nextPage === 1) break;
          continue;
        }
        const video = state.queue[0];
        const dayStart = Date.parse(today + 'T00:00:00+08:00');
        const remaining = Math.min(this.dailySeconds - run.seconds,
          c.limits.dailyMaterialSeconds - this.store.materialSecondsSince(dayStart));
        if (remaining < 20 || (!video.taskKey && this.store.countTasksSince(dayStart) >= c.limits.dailyTasks)) {
          run.note = '今日总学习预算已用完，队列保留到明天'; break;
        }
        let task = video.taskKey ? this.store.getTask(video.taskKey) : null;
        if (!task) {
          ({ task } = this.store.createOrJoinTask({
            topicKey: `curriculum:${this.mid}:${video.bvid}`, topic: video.title,
            question: '学习这个视频中的梗、出处、接法和适用场景',
            metadata: { waiters: [], background: true, directLink: true,
              preferredBvid: video.bvid, preferredUrl: `https://www.bilibili.com/video/${video.bvid}`,
              materialLimitSeconds: Math.min(c.limits.taskMaterialSeconds, remaining) },
          }));
          video.taskKey = task.taskKey;
          save();
        }
        if (!['completed', 'failed', 'cancelled'].includes(task.status)) await c.processTask(task);
        const done = this.store.getTask(task.taskKey);
        if (!['completed', 'failed', 'cancelled'].includes(done?.status)) { save(); return; }
        const learned = done?.status === 'completed' && done?.result?.entry?.verified === true;
        const candidate = done?.status === 'completed' && done?.result?.entry?.confidence === 'medium';
        const item = { bvid: video.bvid, title: video.title, taskKey: task.taskKey,
          status: learned ? 'learned' : candidate ? 'candidate' : 'failed', term: done?.result?.entry?.term || '',
          meaning: String(done?.result?.entry?.meaning || '').slice(0, 2000),
          usage: done?.result?.merged?.usage || [],
          replyHooks: done?.result?.entry?.replyHooks || [],
          error: done?.error || (learned ? '' : candidate ? '已存全局候选记忆，可用于接梗；事实待核实' : '证据未达到高置信入库要求'),
          seconds: Number(done?.result?.materialSeconds) || 0,
          audioStatus: done?.result?.sources?.map(source => source.audioStatus || '本次未学习音频').join('；') || '' };
        run.items.push(item);
        run.seconds += item.seconds;
        const counter = learned ? 'learned' : candidate ? 'candidate' : 'failed';
        state[counter] = (Number(state[counter]) || 0) + 1;
        state.last = { bvid: video.bvid, title: video.title, status: item.status };
        state.seen.push(video.bvid);
        state.queue.shift();
        save();
      }
    } catch (error) {
      run.error = String(error.message).slice(0, 240);
      const transient = error.retryable === true || /HTTP (412|429|5\d\d)|B 站返回 -(352|412)|timeout|fetch failed/i.test(error.message)
        || ['TimeoutError', 'AbortError'].includes(error.name);
      const retries = Number(run.retries) || 0;
      if (transient && retries < 2) {
        run.retries = retries + 1;
        run.retryAt = c.now() + (retries === 0 ? 30 : 120) * 60_000;
        run.status = 'retry-wait';
        save();
        c.logger?.warn?.(`主页学习暂缓：${run.error}；第${run.retries}次补试在 ${new Date(run.retryAt).toISOString()}`);
        return;
      }
    }
    run.status = 'done';
    run.finishedAt = c.now();
    save();
    this.report(state);
  }

  report(state) {
    const run = state.run;
    const lines = [
      `每日梗百科学习报告 ${run.day}`,
      `主页：https://space.bilibili.com/${this.mid}`,
      `今天处理 ${run.items.length} 个视频，学会 ${run.items.filter(i => i.status === 'learned').length} 个，候选 ${run.items.filter(i => i.status === 'candidate').length} 个，材料 ${(run.seconds / 60).toFixed(1)} 分钟。`,
      ...run.items.flatMap(item => [
        `${item.status === 'learned' ? '学会' : item.status === 'candidate' ? '候选可接梗' : '未学会'}：${item.title}`,
        item.status === 'learned' ? `${item.term}：${item.meaning}` : `原因：${item.error}`,
        item.usage?.length ? `用法：${item.usage.join('；')}` : '',
        item.replyHooks?.length ? `接法：${item.replyHooks.join('；')}` : '',
        item.audioStatus ? `音频：${item.audioStatus}` : '',
        `https://www.bilibili.com/video/${item.bvid}`,
      ]),
      run.error ? `本轮中断原因：${run.error}；未处理视频明天继续。` : '',
      run.note || '',
      `累计处理 ${state.seen.length}/${state.total || '?'}，学会 ${state.learned}，候选 ${state.candidate || 0}，未确认 ${state.failed}（记录保留，不算学会）。`,
      state.last ? `学到：${state.last.title}（${state.last.bvid}）` : '还没有完成首个视频。',
      state.queue.length ? `下次继续：${state.queue[0].title}` : `下次读取主页第 ${state.nextPage} 页，跳过已处理 BV。`,
    ].filter(Boolean);
    // A manually resumed failed run can finish later that day. Deliver its new
    // result once instead of treating the earlier failure receipt as success.
    const revision = run.finishedAt || run.startedAt || 0;
    for (const userId of this.recipients) this.store.enqueueDailyReport(`curriculum-report:${this.mid}:${run.day}:${userId}:${revision}`, {
      chatType: 'private', userId,
      text: run.items.map(item => `${item.title}\nhttps://www.bilibili.com/video/${item.bvid}`).join('\n\n') || `梗百科主页\nhttps://space.bilibili.com/${this.mid}`,
      reportText: lines.join('\n'), reportItems: run.items, reportImage: true,
    });
  }
}
