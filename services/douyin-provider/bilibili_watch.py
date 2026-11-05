"""Learn from rendered, normally playing web pages; never resolve media URLs."""
import asyncio
import base64
import re
import time
from contextlib import suppress
from urllib.parse import urlsplit
from browser_audio import START_AUDIO, transcribe_recording

WATCH_SLOTS = asyncio.Semaphore(1)
VIDEO = 'video, bwp-video'
STATE = """() => {
 const v = document.querySelector('video, bwp-video');
 return v ? {time: Number(v.currentTime), duration: Number(v.duration),
   paused: v.paused, ended: v.ended, ready: v.readyState} : null;
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


async def watch_page(context, url, seconds, disconnected):
    """One page per request; restart at zero, then play continuously at normal speed."""
    watch_url(url)
    async with asyncio.timeout(10):
        await WATCH_SLOTS.acquire()
    page = None
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
            start = float(state['time'])
            # Warm up Chromium's screenshot pipeline before the first second.
            await page.screenshot(type='jpeg', quality=60, timeout=10000)
            # Ignore account watch history: only reset once at the beginning.
            await page.evaluate("() => { const v = document.querySelector('video, bwp-video'); v.pause(); v.currentTime = 0; }")
            await page.wait_for_function("() => { const v = document.querySelector('video, bwp-video'); return v.currentTime < 0.5 && !v.seeking; }", timeout=10000)
            try:
                audio_start = await asyncio.wait_for(page.evaluate(START_AUDIO), 5)
            except Exception:
                audio_start = {'ok': False}
            await page.evaluate("() => { document.querySelector('video, bwp-video').play().catch(() => {}); }")
            start = 0.0
            frames = []
            last_time = start - 1
            last_progress = time.monotonic()
            initial = start
            target = min(float(state['duration'] or seconds), start + seconds)
            while True:
                if await disconnected():
                    raise ValueError('学习请求已断开')
                state = await page.evaluate(STATE)
                current = float(state['time'])
                if current >= last_time + 0.95 and current < target:
                    box = await page.evaluate("""() => {
                      const v = document.querySelector('.bpx-player-video-area') || document.querySelector('video, bwp-video');
                      const r = v.getBoundingClientRect();
                      return {x: Math.max(0,r.x), y: Math.max(0,r.y), width: Math.min(r.width,innerWidth-Math.max(0,r.x)), height: Math.min(r.height,innerHeight-Math.max(0,r.y))};
                    }""")
                    frame = await page.screenshot(type='jpeg', quality=75, clip=box, timeout=5000)
                    captions = await page.locator('.bpx-player-subtitle-panel-text').all_inner_texts()
                    frames.append({'time': round(current, 2), 'image': base64.b64encode(frame).decode(),
                                   'caption': ' '.join(captions)[:500]})
                    last_time = current
                    last_progress = time.monotonic()
                if state['ended'] or current >= target:
                    break
                if time.monotonic() - last_progress > 15:
                    raise ValueError('网页播放器超过15秒未前进（缓冲、暂停或验证）；未完成观看')
                await asyncio.sleep(0.05)
            if len(frames) < 2 or current - initial < min(1, seconds):
                raise ValueError('网页没有实际连续播放，不能记为已观看')
            await page.evaluate("() => document.querySelector('video, bwp-video').pause()")
            audio = await transcribe_recording(page, audio_start)
            return {**metadata, 'sourceUrl': page.url, 'duration': state['duration'],
                    'seconds': round(current - initial, 2), 'startTime': initial,
                    'endTime': current, 'frames': frames, 'mode': 'browser-screenshots',
                    'audioObserved': False, 'audio': audio}
    finally:
        if page is not None:
            with suppress(Exception):
                await asyncio.wait_for(page.close(), 3)
        WATCH_SLOTS.release()
