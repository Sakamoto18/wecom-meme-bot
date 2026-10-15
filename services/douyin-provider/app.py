import asyncio
import html
import json
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
from xhs_content import clean_author_name, is_note_url, normalize_note, parse_public_note
from work_metadata import PAGE_DATA_SCRIPT, work_id, page_payloads, find_work, normalize_work

logger = logging.getLogger('uvicorn.error')
context = None
playwright = None
profile_guard = None
xhs_profile_guard = None
login_page = None
bilibili_browser = None
bilibili_context = None
bilibili_login_page = None
xhs_context = None
xhs_login_page = None
lock = asyncio.Lock()
context_lock = asyncio.Lock()
bilibili_context_lock = asyncio.Lock()
xhs_context_lock = asyncio.Lock()
xhs_resolve_lock = asyncio.Lock()
QUEUE_TIMEOUT = 22
RESOLVE_TIMEOUT = 20
NAVIGATION_TIMEOUT_MS = 10000
BILIBILI_NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'
XHS_NAVIGATION_TIMEOUT_MS = 15000
XHS_DATA_WAIT_MS = 8000
XHS_HOSTS = ('www.xiaohongshu.com', 'xiaohongshu.com')
XHS_REMOVED_MARKERS = (
    '笔记不存在', '内容不存在', '当前笔记已删除', '该内容已被删除',
    '无法查看该笔记', '页面不见了', '访问的页面不见了',
)


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


def xhs_profile_path():
    return Path(os.getenv('XHS_PROFILE', '/data/xhs-profile')).resolve()


async def get_xhs_context():
    """Open the persistent Chromium profile used by the XHS resolver.

    This deliberately reuses the Chromium binary from this provider instead
    of adding a second image.  The profile is separate from Douyin's profile
    so logging in or out of one source cannot invalidate the other account.
    """
    global xhs_context, playwright
    async with xhs_context_lock:
        if xhs_context is not None:
            return xhs_context
        if playwright is None:
            playwright = await async_playwright().start()
        profile = xhs_profile_path()
        profile.mkdir(parents=True, exist_ok=True)
        try:
            xhs_context = await playwright.chromium.launch_persistent_context(
                str(profile), headless=False,
                executable_path='/usr/bin/chromium', timeout=10000,
                args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
                      '--disk-cache-size=67108864'],
            )
            xhs_context.set_default_timeout(5000)
            xhs_context.on('close', xhs_context_closed)
            return xhs_context
        except BaseException:
            xhs_context = None
            raise


def xhs_context_closed(*_):
    global xhs_context, xhs_login_page
    xhs_context = None
    xhs_login_page = None


def xhs_removed_marker(text):
    body = str(text or '')
    return next((marker for marker in XHS_REMOVED_MARKERS if marker in body), '')


def is_xhs_host(hostname):
    host = str(hostname or '').lower().rstrip('.')
    return host == 'xiaohongshu.com' or host.endswith('.xiaohongshu.com')


def _looks_like_xhs_note(value):
    if not isinstance(value, dict):
        return False
    kind = str(value.get('type') or value.get('noteType') or '').lower()
    return kind in {'normal', 'video', 'image', 'gallery'} or any(
        key in value for key in ('imageList', 'image_list', 'video')
    )


def _find_xhs_note(value, depth=0, seen=None, target_id=''):
    """Find a note object in the initial state or captured API payload."""
    if depth > 8 or value is None:
        return None
    if seen is None:
        seen = set()
    if isinstance(value, dict):
        marker = id(value)
        if marker in seen:
            return None
        seen.add(marker)
        identity = str(value.get('noteId') or value.get('note_id') or value.get('noteID') or '')
        fallback = None
        if _looks_like_xhs_note(value):
            try:
                fallback = normalize_note(value)
                if target_id and identity == target_id:
                    return fallback
            except (TypeError, ValueError, KeyError):
                pass
        for key in ('note', 'note_card', 'noteCard', 'noteDetail', 'note_detail'):
            candidate = value.get(key)
            found = _find_xhs_note(candidate, depth + 1, seen, target_id)
            if found:
                return found
        for candidate in value.values():
            found = _find_xhs_note(candidate, depth + 1, seen, target_id)
            if found:
                return found
        if fallback:
            return fallback
    elif isinstance(value, list):
        for candidate in value:
            found = _find_xhs_note(candidate, depth + 1, seen, target_id)
            if found:
                return found
    return None


async def rendered_xhs_author(page):
    """Read the note author's visible profile link as a last metadata fallback."""
    script = """() => {
      const ignored = new Set(['我', '首页', '发现', '通知', '消息', '登录', '注册']);
      const links = [...document.querySelectorAll('a[href*="/user/profile/"]')];
      for (const link of links) {
        const text = (link.innerText || link.textContent || '').trim();
        if (!text || ignored.has(text)) continue;
        const image = link.querySelector('img');
        const avatar = image?.currentSrc || image?.src || image?.getAttribute('data-src') || '';
        return {author: text, avatarUrl: avatar};
      }
      return {author: '', avatarUrl: ''};
    }"""
    with suppress(Exception):
        result = await page.evaluate(script)
        if isinstance(result, dict):
            return {
                'author': clean_author_name(result.get('author')),
                'avatarUrl': str(result.get('avatarUrl') or '').strip()
                if clean_author_name(result.get('author')) else '',
            }
    return {'author': '', 'avatarUrl': ''}


def merge_xhs_author(data, author_data):
    if not isinstance(data, dict):
        return data
    if not isinstance(author_data, dict):
        return data
    return {
        **data,
        'author': clean_author_name(data.get('author')) or author_data.get('author') or '',
        'avatarUrl': (data.get('avatarUrl') if clean_author_name(data.get('author'))
                      else author_data.get('avatarUrl') or '') or '',
    }


async def xhs_login_state():
    """Return login metadata without ever returning cookies or tokens."""
    ctx = await get_xhs_context()
    page = xhs_login_page
    if page is None or page.is_closed():
        pages = [item for item in ctx.pages if not item.is_closed()]
        page = pages[0] if pages else None
    cookies = await ctx.cookies(['https://www.xiaohongshu.com'])
    cookie_names = {str(item.get('name') or '') for item in cookies}
    has_session_cookie = bool(cookie_names & {'web_session', 'a1', 'webId'})
    body = ''
    if page is not None:
        with suppress(Exception):
            body = (await page.locator('body').inner_text())[:8000]
    login_words = ('登录', '扫码登录', '登录后')
    logged_in = has_session_cookie and not any(word in body for word in login_words)
    return {
        'logged_in': logged_in,
        'browser_ready': xhs_context is not None,
        'profile_exists': xhs_profile_path().is_dir(),
        'cookie_count': len(cookies),
    }


async def save_xhs_state():
    """Flush the persistent profile and keep a redacted storage-state backup."""
    profile = xhs_profile_path()
    profile.mkdir(parents=True, exist_ok=True)
    ctx = await get_xhs_context()
    fd, temporary = tempfile.mkstemp(prefix='.state-', suffix='.json', dir=profile)
    os.close(fd)
    state = profile / 'state.json'
    try:
        await ctx.storage_state(path=temporary)
        os.chmod(temporary, 0o600)
        os.replace(temporary, state)
        os.chmod(state, 0o600)
    finally:
        with suppress(FileNotFoundError):
            os.unlink(temporary)
    return state


async def resolve_xhs_request(url):
    """Resolve a note in the logged-in browser, preserving author metadata."""
    ctx = await get_xhs_context()
    page = None
    payloads = []
    response_tasks = set()

    async def capture_response(response):
        try:
            parsed = urlsplit(response.url)
            if not is_xhs_host(parsed.hostname):
                return
            content_type = response.headers.get('content-type', '')
            if response.status != 200:
                return
            if 'json' not in content_type.lower():
                return
            payload = await response.json()
            if len(payloads) < 128:
                payloads.append(payload)
        except Exception:
            return

    def capture(response):
        task = asyncio.create_task(capture_response(response))
        response_tasks.add(task)
        task.add_done_callback(response_tasks.discard)

    try:
        page = await ctx.new_page()
        page.on('response', capture)
        try:
            response = await page.goto(
                url, wait_until='commit', timeout=XHS_NAVIGATION_TIMEOUT_MS,
            )
        except PlaywrightTimeoutError:
            logger.warning('XHS navigation deadline reached; inspecting rendered page')
            response = None
        await page.wait_for_timeout(800)
        deadline = time.monotonic() + XHS_DATA_WAIT_MS / 1000
        html_text = ''
        canonical = page.url
        target_id = urlsplit(canonical).path.rstrip('/').rsplit('/', 1)[-1]
        author_data = {'author': '', 'avatarUrl': ''}
        author_checked_at = 0.0
        with suppress(Exception):
            author_data = await rendered_xhs_author(page)
        while time.monotonic() < deadline:
            for task in list(response_tasks):
                with suppress(Exception):
                    await task
            canonical = page.url
            target_id = urlsplit(canonical).path.rstrip('/').rsplit('/', 1)[-1]
            if time.monotonic() - author_checked_at >= 1.0:
                author_checked_at = time.monotonic()
                with suppress(Exception):
                    rendered = await rendered_xhs_author(page)
                    author_data = {
                        'author': author_data.get('author') or rendered.get('author') or '',
                        'avatarUrl': author_data.get('avatarUrl') or rendered.get('avatarUrl') or '',
                    }
            # Prefer structured note/API data over OG metadata so a video
            # cover is never returned as a gallery before its stream arrives.
            with suppress(Exception):
                state = await page.evaluate('() => window.__INITIAL_STATE__ || null')
                parsed = _find_xhs_note(state, target_id=target_id)
                if parsed:
                    return merge_xhs_author(parsed, author_data)
            with suppress(Exception):
                for script in await page.locator('script').all_text_contents():
                    source = script.strip()
                    if not source or not source.startswith(('{', '[')):
                        continue
                    parsed = _find_xhs_note(json.loads(source), target_id=target_id)
                    if parsed:
                        return merge_xhs_author(parsed, author_data)
            for payload in payloads:
                parsed = _find_xhs_note(payload, target_id=target_id)
                if parsed:
                    return merge_xhs_author(parsed, author_data)
            await page.wait_for_timeout(250)
        html_text = await page.content()
        if is_note_url(canonical):
            with suppress(Exception):
                parsed = parse_public_note(html_text, canonical)
                if parsed:
                    return merge_xhs_author(parsed, author_data)
        marker = xhs_removed_marker(await page.locator('body').inner_text())
        if marker:
            raise ValueError(f'content_removed: 小红书提示「{marker}」')
        status = await xhs_login_state()
        if not status['logged_in']:
            raise ValueError('小红书登录态无效，请访问 /xhs-login.png 扫码登录')
        safe_url = urlsplit(canonical)
        logger.warning(
            'XHS page no data url=%s title=%s final_path=%s payloads=%d body=%s',
            f'{safe_url.netloc}{safe_url.path}',
            (await page.title())[:120], safe_url.path, len(payloads),
            ' '.join((await page.locator('body').inner_text())[:240].split()),
        )
        raise ValueError('小红书页面未返回可用笔记数据')
    finally:
        if page is not None:
            page.remove_listener('response', capture)
            with suppress(Exception):
                await page.close()
        for task in response_tasks:
            task.cancel()
        await asyncio.gather(*response_tasks, return_exceptions=True)


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
    global profile_guard, xhs_profile_guard
    # This lock is held for the entire process lifetime, including browser startup.
    profile_guard = acquire_profile(os.getenv('DOUYIN_PROFILE', '/data/profile'))
    xhs_profile_guard = acquire_profile(xhs_profile_path())
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
        if xhs_context is not None:
            with suppress(Exception):
                await asyncio.wait_for(xhs_context.close(), 5)
        if context is not None:
            with suppress(Exception):
                await asyncio.wait_for(context.close(), 5)
        if playwright is not None:
            await playwright.stop()
        if xhs_profile_guard is not None:
            xhs_profile_guard.close()
        profile_guard.close()


app = FastAPI(lifespan=lifespan)


class Req(BaseModel):
    url: str


@app.get('/healthz')
async def health():
    ready = context is not None
    return JSONResponse({'status': 'ok' if ready else 'unavailable', 'browser_ready': ready,
                         'xhs_profile': str(xhs_profile_path()),
                         'xhs_browser_ready': xhs_context is not None},
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


@app.get('/xhs-login.png')
async def xhs_login_png():
    global xhs_login_page
    ctx = await get_xhs_context()
    if xhs_login_page is None or xhs_login_page.is_closed():
        xhs_login_page = await ctx.new_page()
        await xhs_login_page.goto(
            'https://www.xiaohongshu.com/',
            wait_until='domcontentloaded', timeout=XHS_NAVIGATION_TIMEOUT_MS,
        )
    return Response(await xhs_login_page.screenshot(type='png', full_page=False), media_type='image/png')


@app.get('/xhs-login-status')
async def xhs_login_status():
    return await xhs_login_state()


@app.post('/xhs-save-session')
async def xhs_save_session():
    status = await xhs_login_state()
    if not status['logged_in']:
        return JSONResponse(status | {'saved': False}, status_code=409)
    state = await save_xhs_state()
    return {'logged_in': True, 'saved': True, 'state_file': str(state)}


@app.post('/xhs/resolve')
async def xhs_resolve(req: Req):
    started = time.monotonic()
    try:
        await asyncio.wait_for(xhs_resolve_lock.acquire(), QUEUE_TIMEOUT)
        try:
            async with asyncio.timeout(RESOLVE_TIMEOUT):
                data = await resolve_xhs_request(req.url)
            logger.info('XHS resolve ok duration_ms=%d kind=%s images=%d author=%s',
                        (time.monotonic() - started) * 1000,
                        data.get('media_type', ''), len(data.get('images') or []),
                        bool(data.get('author')))
            return {'status': 'success', 'data': data}
        finally:
            xhs_resolve_lock.release()
    except TimeoutError:
        logger.warning('XHS resolve timeout duration_ms=%d', (time.monotonic() - started) * 1000)
        return {'status': 'failed', 'msg': '小红书 Provider 超时'}
    except Exception as error:
        reason = str(error).strip() or type(error).__name__
        removed = reason.startswith('content_removed')
        logger.warning('XHS resolve %s reason=%s', 'removed' if removed else 'failed', reason[:200])
        return {'status': 'failed', 'removed': removed, 'msg': reason[:300]}


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
