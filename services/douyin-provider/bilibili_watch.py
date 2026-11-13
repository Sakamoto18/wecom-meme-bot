"""Learn from rendered, normally playing web pages; never resolve media URLs."""
import asyncio
import math
import re
import time
from contextlib import suppress
from urllib.parse import urlsplit
from browser_audio import START_AUDIO, transcribe_recording

WATCH_SLOTS = asyncio.Semaphore(1)
QUEUE_SECONDS = 45


class WatchBusyError(ValueError):
    pass


VIDEO = 'video, bwp-video'
STATE = """() => {
 const v = document.querySelector('video, bwp-video');
 return v ? {time: Number(v.currentTime), duration: Number(v.duration),
   paused: v.paused, ended: v.ended, ready: v.readyState,
   completion: window.__learningCompletion || null,
   bvid: window.__INITIAL_STATE__?.videoData?.bvid || location.pathname.match(/BV[0-9A-Za-z]{10}/)?.[0]} : null;
}"""


def watch_url(url):
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.username or parts.password or parts.port:
        raise ValueError('只允许 HTTPS B站视频网页')
    if parts.hostname == 'b23.tv' and re.fullmatch(r'/[A-Za-z0-9]+/?', parts.path):
        return url
    if parts.hostname in ('www.bilibili.com', 'bilibili.com') and re.fullmatch(r'/video/BV[0-9A-Za-z]{10}/?', parts.path):
        return url
    raise ValueError('只允许 B站视频或 b23 分享网页')


def playback_complete(state, target):
    duration = float(state.get('duration') or target)
    return bool(state.get('ended')) or float(state['time']) >= min(target, duration) - 0.25


# Record the original element's ended event before the site's auto-replay/next
# handlers can reset currentTime. This is evidence of completion, not a guess.
INSTALL_COMPLETION = """() => {
 const v = document.querySelector('video, bwp-video');
 window.__learningCompletion = null;
 v.loop = false;
 v.addEventListener('ended', () => {
   window.__learningCompletion = {time: Number(v.currentTime), duration: Number(v.duration)};
   v.pause();
 }, {once: true, capture: true});
}"""


def completed_time(state, target, highest):
    completion = state.get('completion')
    if completion and playback_complete(completion, target) and highest >= min(target, float(completion['duration'])) - 3:
        return min(target, float(completion['time']))
    if playback_complete(state, target) and highest >= min(target, float(state.get('duration') or target)) - 3:
        return min(target, float(state['time']))
    return None


async def screenshot_frame(page, session, box=None):
    # CDP captures rendered pixels without Playwright's page-wide font wait.
    params = {'format': 'jpeg', 'quality': 75, 'captureBeyondViewport': False}
    if box:
        params['clip'] = {**box, 'scale': 1}
    for attempt in range(2):
        try:
            result = await asyncio.wait_for(session.send('Page.captureScreenshot', params), 8)
            return result['data']
        except Exception as error:
            if attempt or page.is_closed():
                raise ValueError('截图阶段失败（已重试一次）：' + (str(error) or type(error).__name__)[:180]) from error
            await page.bring_to_front()


async def watch_page(context, url, seconds, disconnected):
    # Monitor the whole request, including slot wait and ASR. A backend restart
    # must cancel its old page/process before a recovered task occupies the slot.
    async def monitor():
        while True:
            if await disconnected():
                return
            await asyncio.sleep(0.5)
    operation = asyncio.create_task(_watch_page(context, url, seconds, disconnected))
    monitor_task = asyncio.create_task(monitor())
    try:
        done, _ = await asyncio.wait([operation, monitor_task], return_when=asyncio.FIRST_COMPLETED)
        if operation in done:
            return await operation
        raise ValueError('学习请求已断开，已释放观看任务')
    finally:
        for task in (operation, monitor_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(operation, monitor_task, return_exceptions=True)


async def _watch_page(context, url, seconds, disconnected):
    """One page per request; restart at zero, then play continuously at normal speed."""
    watch_url(url)
    try:
        async with asyncio.timeout(QUEUE_SECONDS):
            await WATCH_SLOTS.acquire()
    except TimeoutError as error:
        raise WatchBusyError('观看服务忙：等待空位45秒超时，尚未开始观看') from error
    page = None
    stage = '打开网页'
    try:
        async with asyncio.timeout(seconds + 180):
            page = await context.new_page()
            await page.goto(url, wait_until='domcontentloaded', timeout=30000)
            watch_url(page.url)
            await page.locator(VIDEO).first.wait_for(state='visible', timeout=25000)
            await page.bring_to_front()
            # The website owns playback and streaming. Muting permits autoplay;
            # rendered pixels and optional tab audio are used for learning.
            await page.evaluate("() => { const v = document.querySelector('video, bwp-video'); v.muted = true; v.playbackRate = 1; }")
            state = await page.evaluate(STATE)
            if state['paused']:
                button = page.locator('.bpx-player-ctrl-play')
                if await button.count():
                    await button.first.click(timeout=5000)
                else:
                    await page.locator(VIDEO).first.click(timeout=5000)
            await page.wait_for_function("""() => {
              const v = document.querySelector('video, bwp-video');
              return v && !v.paused && v.readyState >= 2;
            }""", timeout=15000)
            metadata = await page.evaluate("""() => {
              const d = window.__INITIAL_STATE__?.videoData || {};
              return {bvid: d.bvid || location.pathname.match(/BV[0-9A-Za-z]{10}/)?.[0],
                aid: d.aid || 0, cid: d.cid || 0, title: document.querySelector('h1')?.innerText || document.title,
                description: document.querySelector('.basic-desc-info')?.innerText || d.desc || ''};
            }""")
            state = await page.evaluate(STATE)
            session = await context.new_cdp_session(page)
            stage = '截图预热'
            await screenshot_frame(page, session)
            # Ignore account watch history: only reset once at the beginning.
            await page.evaluate("() => { const v = document.querySelector('video, bwp-video'); v.pause(); v.currentTime = 0; }")
            await page.wait_for_function("() => { const v = document.querySelector('video, bwp-video'); return v.currentTime < 0.5 && !v.seeking; }", timeout=10000)
            await page.evaluate(INSTALL_COMPLETION)
            try:
                audio_start = await asyncio.wait_for(page.evaluate(START_AUDIO), 5)
            except Exception:
                audio_start = {'ok': False}
            await page.evaluate("() => { document.querySelector('video, bwp-video').play().catch(() => {}); }")
            start = 0.0
            frames = []
            stage = '连续播放与截图'
            highest = 0.0
            last_time = start - 1
            last_progress = time.monotonic()
            initial = start
            duration = float(state['duration'] or seconds)
            if not math.isfinite(duration) or duration <= 0:
                raise ValueError('播放阶段失败：视频时长无效')
            target = min(duration, start + seconds)
            last_log = -30
            resumed_at = None
            while True:
                state = await page.evaluate(STATE)
                if not state:
                    raise ValueError('播放阶段失败：原视频元素已消失')
                current = float(state['time'])
                if not math.isfinite(current):
                    raise ValueError('播放阶段失败：时间轴无效')
                if state.get('bvid') and state['bvid'] != metadata['bvid'] and not state.get('completion'):
                    raise ValueError('播放阶段失败：原视频未结束就自动切换到其他视频')
                finished = completed_time(state, target, highest)
                if finished is not None:
                    current = finished
                    break
                if state.get('bvid') and state['bvid'] != metadata['bvid']:
                    raise ValueError('播放阶段失败：原视频未结束就自动切换到其他视频')
                if current < highest - 2:
                    raise ValueError(f'播放时间轴回退：{highest:.2f} -> {current:.2f} 秒，未收到原视频结束事件；未完成观看')
                if current > highest + 0.05:
                    highest = current
                    last_progress = time.monotonic()
                if current - last_log >= 30:
                    print(f'Bilibili watch {metadata.get("bvid")} time={current:.2f} duration={state["duration"]} frames={len(frames)} paused={state["paused"]}', flush=True)
                    last_log = current
                if current >= last_time + 0.95 and current < target:
                    box = await page.evaluate("""() => {
                      const v = document.querySelector('.bpx-player-video-area') || document.querySelector('video, bwp-video');
                      const r = v.getBoundingClientRect();
                      return {x: Math.max(0,r.x), y: Math.max(0,r.y), width: Math.min(r.width,innerWidth-Math.max(0,r.x)), height: Math.min(r.height,innerHeight-Math.max(0,r.y))};
                    }""")
                    frame = await screenshot_frame(page, session, box)
                    captions = await page.locator('.bpx-player-subtitle-panel-text').all_inner_texts()
                    frames.append({'time': round(current, 2), 'image': frame,
                                   'caption': ' '.join(captions)[:500]})
                    last_time = current
                    last_progress = time.monotonic()
                if time.monotonic() - last_progress > 5 and state['paused'] and resumed_at != last_time:
                    # A site overlay may pause playback; resume once per stall.
                    await page.evaluate("() => { document.querySelector('video, bwp-video').play().catch(() => {}); }")
                    resumed_at = last_time
                if time.monotonic() - last_progress > 30:
                    raise ValueError(f'网页播放器停滞30秒：time={current:.2f}/{state["duration"]} paused={state["paused"]} ended={state["ended"]} ready={state["ready"]} frames={len(frames)}；未完成观看')
                await asyncio.sleep(0.05)
            if len(frames) < 2 or current - initial < min(1, seconds):
                raise ValueError('网页没有实际连续播放，不能记为已观看')
            await page.evaluate("() => document.querySelector('video, bwp-video').pause()")
            stage = '音频转写'
            audio = await transcribe_recording(page, audio_start)
            return {**metadata, 'sourceUrl': page.url, 'duration': state['duration'],
                    'seconds': round(current - initial, 2), 'startTime': initial,
                    'endTime': current, 'frames': frames, 'mode': 'browser-screenshots',
                    'audioObserved': False, 'audio': audio}
    except TimeoutError as error:
        raise ValueError(f'网页观看总时限超出：阶段={stage}，上限={seconds + 180}秒') from error
    finally:
        if page is not None:
            with suppress(Exception):
                await asyncio.wait_for(page.close(), 3)
        WATCH_SLOTS.release()
