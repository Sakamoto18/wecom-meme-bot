import asyncio
import html
import logging
import os
import tempfile
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError, Error as PlaywrightError
from profile_guard import acquire_profile
from work_metadata import PAGE_DATA_SCRIPT, work_id, page_payloads, find_work, normalize_work

logger = logging.getLogger('uvicorn.error')
context = None
playwright = None
profile_guard = None
login_page = None
bilibili_browser = None
bilibili_context = None
bilibili_login_page = None
lock = asyncio.Lock()
context_lock = asyncio.Lock()
bilibili_context_lock = asyncio.Lock()
QUEUE_TIMEOUT = 22
RESOLVE_TIMEOUT = 20
NAVIGATION_TIMEOUT_MS = 10000
BILIBILI_NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'


def is_real_video_url(url):
    low = str(url or '').lower()
    return low.startswith(('https://', 'http://')) and 'uuu_265.mp4' not in low and any(
        token in low for token in (
            '.mp4', '.m3u8', 'playwm', 'play/',
            'douyinvod.com/', '/video/', 'mime_type=video_',
        )
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


def bilibili_state_path():
    return Path(os.getenv('BILIBILI_AUTH_STATE', '/data/bilibili-auth/state.json')).resolve()


async def get_bilibili_context():
    """Open a temporary Chromium context backed by a small storage-state file.

    The Douyin provider already owns the Chromium binary. Bilibili does not get
    another image or a full user-data directory: only cookies/local storage are
    persisted in ``BILIBILI_AUTH_STATE``.
    """
    global bilibili_browser, bilibili_context, playwright
    async with bilibili_context_lock:
        if bilibili_context is not None:
            return bilibili_context
        if playwright is None:
            playwright = await async_playwright().start()
        if bilibili_browser is None:
            bilibili_browser = await playwright.chromium.launch(
                headless=False,
                executable_path='/usr/bin/chromium',
                timeout=10000,
                args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
                      '--disk-cache-size=67108864'],
            )
        state = bilibili_state_path()
        kwargs = {'viewport': {'width': 1440, 'height': 1000}}
        if state.is_file() and state.stat().st_size > 0:
            kwargs['storage_state'] = str(state)
        try:
            bilibili_context = await bilibili_browser.new_context(**kwargs)
        except Exception as error:
            # A truncated state file must not stop the whole Douyin provider.
            logger.warning('Bilibili storage state invalid; starting a clean context: %s', error)
            kwargs.pop('storage_state', None)
            bilibili_context = await bilibili_browser.new_context(**kwargs)
        bilibili_context.set_default_timeout(5000)
        bilibili_context.on('close', bilibili_context_closed)
        return bilibili_context


def bilibili_context_closed(*_):
    global bilibili_context, bilibili_login_page
    bilibili_context = None
    bilibili_login_page = None


async def bilibili_login_state():
    ctx = await get_bilibili_context()
    try:
        response = await ctx.request.get(
            BILIBILI_NAV_URL,
            headers={
                'referer': 'https://www.bilibili.com/',
                'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
            },
            timeout=5000,
        )
        if not response.ok:
            return {'logged_in': False, 'code': response.status, 'message': 'nav_http_error'}
        payload = await response.json()
        data = payload.get('data') if isinstance(payload, dict) else {}
        return {
            'logged_in': payload.get('code') == 0 and bool(data.get('isLogin')),
            'code': payload.get('code'),
            'message': payload.get('message', ''),
        }
    except Exception as error:
        return {'logged_in': False, 'code': None, 'message': type(error).__name__}


async def save_bilibili_state():
    state = bilibili_state_path()
    state.parent.mkdir(parents=True, exist_ok=True)
    state.parent.chmod(0o700)
    ctx = await get_bilibili_context()
    fd, temporary = tempfile.mkstemp(prefix='.state-', suffix='.json', dir=state.parent)
    os.close(fd)
    try:
        await ctx.storage_state(path=temporary)
        os.chmod(temporary, 0o600)
        os.replace(temporary, state)
        os.chmod(state, 0o600)
    finally:
        with suppress(FileNotFoundError):
            os.unlink(temporary)
    return state


async def bilibili_cookie_header():
    if not bilibili_state_path().is_file():
        return {'logged_in': False, 'code': None, 'message': 'state_file_missing', 'cookie': ''}
    status = await bilibili_login_state()
    if not status['logged_in']:
        return status | {'cookie': ''}
    ctx = await get_bilibili_context()
    cookies = await ctx.cookies(['https://www.bilibili.com', 'https://api.bilibili.com'])
    header = '; '.join(
        f"{item['name']}={item['value']}"
        for item in cookies
        if item.get('name') and item.get('value')
    )
    if header:
        await save_bilibili_state()
    return status | {'cookie': header}


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
        if bilibili_context is not None:
            with suppress(Exception):
                await asyncio.wait_for(bilibili_context.close(), 5)
        if bilibili_browser is not None:
            with suppress(Exception):
                await asyncio.wait_for(bilibili_browser.close(), 5)
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


@app.get('/bilibili-login.png')
async def bilibili_login_png():
    global bilibili_login_page
    ctx = await get_bilibili_context()
    if bilibili_login_page is None or bilibili_login_page.is_closed():
        bilibili_login_page = await ctx.new_page()
        await bilibili_login_page.goto('https://www.bilibili.com/', wait_until='domcontentloaded', timeout=20000)
    return Response(await bilibili_login_page.screenshot(type='png', full_page=False), media_type='image/png')


@app.get('/bilibili-login-status')
async def bilibili_login_status():
    status = await bilibili_login_state()
    status['state_file'] = bilibili_state_path().is_file()
    return status


@app.post('/bilibili-save-session')
async def bilibili_save_session():
    status = await bilibili_login_state()
    if not status['logged_in']:
        return JSONResponse(status | {'saved': False}, status_code=409)
    state = await save_bilibili_state()
    return {'logged_in': True, 'saved': True, 'state_file': str(state)}


@app.get('/bilibili-cookie')
async def bilibili_cookie():
    # Internal Docker-network endpoint. Never log or expose the cookie in any
    # status response; qq-bot consumes it only for the upstream API call.
    status = await bilibili_cookie_header()
    return JSONResponse(status if status.get('cookie') else {k: v for k, v in status.items() if k != 'cookie'},
                        status_code=200 if status.get('logged_in') and status.get('cookie') else 401)


# 作品被删或下架时，抖音整页只给一句提示。把这种情况和"我们没抓到"分开，
# 否则每次都要人去翻页面才能确认不是解析逻辑坏了。
REMOVED_MARKERS = (
    '你要观看的图文不存在',
    '你要观看的视频不存在',
    '你要观看的内容不存在',
    '作品不存在',
    '视频不存在',
    '已被作者删除',
    '内容已被删除',
)
REMOVED_REASON_PREFIX = 'content_removed'


def removed_marker(text):
    """页面文案里是否有"内容不存在"的明确说法。"""
    body = str(text or '')
    return next((marker for marker in REMOVED_MARKERS if marker in body), '')


async def read_page(page, url, payloads, state):
    state['stage'] = 'navigation'
    target_id = work_id(url)
    try:
        response = await page.goto(url, wait_until='domcontentloaded', timeout=NAVIGATION_TIMEOUT_MS)
        target_id = target_id or work_id(response.url if response else page.url)
    except PlaywrightTimeoutError:
        logger.warning('Douyin navigation deadline reached; inspecting work metadata')
    target_id = target_id or work_id(page.url)
    state['stage'] = 'work_metadata'
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        target_id = target_id or work_id(page.url)
        try:
            snapshot = await page.evaluate(PAGE_DATA_SCRIPT)
        except PlaywrightError as error:
            # Anti-bot/short-link redirects can replace the document during evaluation.
            if 'Execution context was destroyed' not in str(error) and 'Cannot find context' not in str(error):
                raise
            await page.wait_for_timeout(250)
            continue
        # Each request owns its payload list. Ignore recommendation/previous-work IDs.
        for payload in [*payloads, *page_payloads(snapshot)]:
            detail = find_work(payload, target_id)
            if detail:
                data = normalize_work(detail, target_id)
                if data:
                    logger.info('Douyin work verified id=%s kind=%s', target_id, data['media_type'])
                    return {'status': 'success', 'data': data}
        await page.wait_for_timeout(250)
    marker = removed_marker(await page.evaluate('() => document.body?.innerText || ""'))
    if marker:
        raise ValueError(f'{REMOVED_REASON_PREFIX}: 抖音提示「{marker}」')
    raise ValueError('work_metadata_unavailable: 未取得当前作品的完整类型和资源，请稍后重试')


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
            payloads = []
            capture_tasks = set()

            async def capture_detail(response):
                if urlsplit(response.url).path.rstrip('/') != '/aweme/v1/web/aweme/detail':
                    return
                if response.status != 200:
                    return
                with suppress(Exception):
                    payload = await response.json()
                    if len(payloads) < 20:
                        payloads.append(payload)

            def capture(response):
                task = asyncio.create_task(capture_detail(response))
                capture_tasks.add(task)
                task.add_done_callback(capture_tasks.discard)

            page.on('response', capture)
            try:
                result = await read_page(page, req.url, payloads, state)
            finally:
                page.remove_listener('response', capture)
                for task in capture_tasks:
                    task.cancel()
                await asyncio.gather(*capture_tasks, return_exceptions=True)
        logger.info('Douyin resolve ok source=%s duration_ms=%d kind=%s cover=%s images=%d',
                    label, (time.monotonic()-started)*1000,
                    result['data'].get('media_type', ''), bool(result['data']['cover']),
                    len(result['data'].get('images') or []))
        return result
    except TimeoutError:
        logger.warning('Douyin resolve timeout source=%s stage=%s duration_ms=%d',
                       label, state['stage'], (time.monotonic()-started)*1000)
        return {'status': 'failed', 'msg': f"抖音 Provider 超时 stage={state['stage']}"}
    except Exception as error:
        # 原因要带出去。只回类型名的话，"作品被删了"和"页面没加载完"在上游
        # 看起来都是 (ValueError)，排查时只能靠人去翻页面。
        reason = str(error).strip() or type(error).__name__
        removed = reason.startswith('content_removed')
        logger.warning('Douyin resolve %s source=%s stage=%s reason=%s',
                       'removed' if removed else 'failed',
                       label, state['stage'], reason[:160])
        return {
            'status': 'failed',
            'removed': removed,
            'msg': f"抖音 Provider 失败 stage={state['stage']}：{reason}"[:300],
        }
    finally:
        if page is not None:
            with suppress(Exception):
                await asyncio.wait_for(page.close(), 2)
        if acquired:
            lock.release()
