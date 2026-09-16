import asyncio
import html
import logging
import os
import time
from contextlib import asynccontextmanager, suppress
from urllib.parse import urlsplit

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError
from profile_guard import acquire_profile

logger = logging.getLogger('uvicorn.error')
context = None
playwright = None
profile_guard = None
login_page = None
lock = asyncio.Lock()
context_lock = asyncio.Lock()
QUEUE_TIMEOUT = 22
RESOLVE_TIMEOUT = 20
NAVIGATION_TIMEOUT_MS = 10000


def is_real_video_url(url):
    low = str(url or '').lower()
    return low.startswith(('https://', 'http://')) and 'uuu_265.mp4' not in low and any(
        token in low for token in ('.mp4', '.m3u8', 'playwm', 'play/')
    )


async def get_context():
    global context, playwright
    async with context_lock:
        if context is not None:
            return context
        if playwright is None:
            playwright = await async_playwright().start()
        try:
            context = await playwright.chromium.launch_persistent_context(
                os.getenv('DOUYIN_PROFILE', '/data/profile'), headless=False,
                executable_path='/usr/bin/chromium', timeout=10000,
                args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
            )
            context.set_default_timeout(3000)
            context.on('close', context_closed)
            return context
        except BaseException:
            await playwright.stop()
            playwright = None
            raise


def context_closed(*_):
    global context, login_page
    context = None
    login_page = None


@asynccontextmanager
async def lifespan(app):
    global profile_guard
    # This lock is held for the entire process lifetime, including browser startup.
    profile_guard = acquire_profile(os.getenv('DOUYIN_PROFILE', '/data/profile'))
    try:
        await get_context()
        logger.info('Douyin browser ready; persistent login profile preserved')
        yield
    finally:
        if context is not None:
            with suppress(Exception):
                await asyncio.wait_for(context.close(), 5)
        if playwright is not None:
            await playwright.stop()
        profile_guard.close()


app = FastAPI(lifespan=lifespan)


class Req(BaseModel):
    url: str


@app.get('/healthz')
async def health():
    ready = context is not None
    return JSONResponse({'status': 'ok' if ready else 'unavailable', 'browser_ready': ready},
                        status_code=200 if ready else 503)


@app.get('/login.png')
async def login_png():
    global login_page
    ctx = await get_context()
    if login_page is None or login_page.is_closed():
        login_page = await ctx.new_page()
        await login_page.goto('https://www.douyin.com/', wait_until='domcontentloaded', timeout=20000)
    return Response(await login_page.screenshot(type='png', full_page=False), media_type='image/png')


@app.get('/login-status')
async def login_status():
    if login_page is None or login_page.is_closed():
        return {'logged_in': False, 'browser_ready': context is not None}
    text = (await login_page.locator('body').inner_text())[:5000]
    return {'logged_in': bool('登录' not in text or '我的' in text or '退出登录' in text)}


EXTRACT_SCRIPT = r'''() => {
    const resources=performance.getEntriesByType('resource').map(x=>x.name);
    const videos=[...document.querySelectorAll('video')].flatMap(v=>[v.currentSrc,v.src]);
    const meta=(name)=>document.querySelector(`meta[name="${name}"]`)?.content||'';
    const authorImg=[...document.images].find(img=>/aweme-avatar/i.test(img.src) && img.alt && !/icon/i.test(img.alt));
    const avatar=authorImg?.currentSrc || '';
    const author=authorImg?.alt || '';
    const keywords=meta('keywords').split(',').map(x=>x.trim()).filter(Boolean);
    const poster=[...document.querySelectorAll('video[poster], video')].map(v=>v.poster || '').find(Boolean) || '';
    const html=document.documentElement?.outerHTML || '';
    const urls=[...html.matchAll(/https?:\/\/[^"'\s<>]+/g)].map(m=>m[0].replaceAll('\/','/'));
    const candidates=[...videos,...resources,...urls].filter(Boolean);
    const video=candidates.find(u=>{ const low=String(u).toLowerCase(); return low.indexOf('uuu_265.mp4')<0 && (/\.(mp4|m3u8)(?:[?#]|$)/i.test(u)||/playwm|play\//i.test(u)); }) || '';
    const imageCandidates=[...document.images].map(img=>img.currentSrc || img.src || '').filter(Boolean);
    const embeddedCover=imageCandidates.find(u=>{ const low=String(u).toLowerCase(); return !/aweme-avatar|icon|logo/.test(low) && /\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(u); }) || '';
    return {title:document.title,desc:meta('description'),cover:meta('lark:url:video_cover_image_url') || document.querySelector('meta[property="og:image"]')?.content || poster || embeddedCover,video,author,avatar,tags:keywords};
   }'''


async def read_page(page, url, video_requests, state):
    state['stage'] = 'navigation'
    try:
        await page.goto(url, wait_until='domcontentloaded', timeout=NAVIGATION_TIMEOUT_MS)
    except PlaywrightTimeoutError:
        # A loaded player may be usable even if another resource blocks DOMContentLoaded.
        logger.warning('Douyin navigation deadline reached; inspecting current document')
    state['stage'] = 'player'
    await page.wait_for_timeout(1800)
    # Do not wait 30s for a missing/hidden video element on a gallery or login page.
    await page.evaluate("""() => { for (const v of document.querySelectorAll('video')) {
        v.muted = true; v.play().catch(() => {});
    } }""")
    await page.wait_for_timeout(2500)
    state['stage'] = 'extract'
    data = await page.evaluate(EXTRACT_SCRIPT)
    if not is_real_video_url(data.get('video')):
        data['video'] = next((u for u in reversed(video_requests) if is_real_video_url(u)), '')
    if not data.get('video'):
        raise ValueError('no_video_resource: 页面未返回视频资源（需检查页面类型或登录验证）')
    return {'status': 'success', 'data': {
        'media_type': 'video', 'video_url': html.unescape(data['video']),
        'cover': data.get('cover', ''), 'title': data.get('title', ''),
        'description': data.get('desc', ''), 'author': data.get('author', ''),
        'avatar_url': data.get('avatar', ''), 'tags': data.get('tags', []),
    }}


@app.post('/resolve')
async def resolve(req: Req):
    started = time.monotonic()
    state = {'stage': 'queue'}
    page = None
    acquired = False
    source = urlsplit(req.url)
    label = source.netloc + source.path  # Never log cookies or signed query parameters.
    try:
        await asyncio.wait_for(lock.acquire(), QUEUE_TIMEOUT)
        acquired = True
        logger.info('Douyin resolve start source=%s queue_ms=%d', label, (time.monotonic()-started)*1000)
        async with asyncio.timeout(RESOLVE_TIMEOUT):
            state['stage'] = 'browser'
            ctx = await get_context()
            page = await ctx.new_page()
            video_requests = []

            def capture(response):
                if 200 <= response.status < 400 and is_real_video_url(response.url):
                    if response.url not in video_requests:
                        video_requests.append(response.url)

            page.on('response', capture)
            result = await read_page(page, req.url, video_requests, state)
        logger.info('Douyin resolve ok source=%s duration_ms=%d cover=%s',
                    label, (time.monotonic()-started)*1000, bool(result['data']['cover']))
        return result
    except TimeoutError:
        logger.warning('Douyin resolve timeout source=%s stage=%s duration_ms=%d',
                       label, state['stage'], (time.monotonic()-started)*1000)
        return {'status': 'failed', 'msg': f"抖音 Provider 超时 stage={state['stage']}"}
    except Exception as error:
        logger.warning('Douyin resolve failed source=%s stage=%s error=%s',
                       label, state['stage'], type(error).__name__)
        return {'status': 'failed', 'msg': f"抖音 Provider 失败 stage={state['stage']} ({type(error).__name__})"}
    finally:
        if page is not None:
            with suppress(Exception):
                await asyncio.wait_for(page.close(), 2)
        if acquired:
            lock.release()
