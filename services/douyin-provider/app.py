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


# 图文（/note/）页面的图集：内容图走 tos-cn-i-0813c000-ce 路径，表情、头像、
# 特效和站点 UI 素材各有自己的路径，按路径排除比按尺寸可靠。轮播只渲染当前
# 附近几张，其余要翻页才会加载，所以这里同时读出轮播计数器的总数。
GALLERY_SCRIPT = r'''() => {
    const items=[];
    for (const img of document.images) {
        const src=img.currentSrc || img.src || '';
        if (!/douyinpic\.com/.test(src)) continue;
        // 图集图片带 aweme_images 标记；封面走 pcweb_cover、表情和头像各有
        // 自己的路径，都和图集共用图片域名，只按域名或尺寸筛会混进来。
        if (!/tplv-dy-aweme-images|biz_tag=aweme_images/.test(src)) continue;
        const matched=src.match(/\/([A-Za-z0-9]+)~tplv/);
        if (matched) items.push({id: matched[1], url: src});
    }
    // 轮播计数器渲染前页面上会先有一个 "00 / 00" 占位，和真正的 "1/7" 同时
    // 存在，取第一个匹配会拿到 0；只认总数大于 0 的那个。
    const pairs=[...(document.body?.innerText || '').matchAll(/\b(\d+)\s*\/\s*(\d+)\b/g)]
        .map(m=>({current: Number(m[1]), total: Number(m[2])}))
        .filter(p=>p.total > 0 && p.current > 0 && p.current <= p.total);
    const counter=pairs[0] || {current: 0, total: 0};
    return {items, current: counter.current, total: counter.total, path: location.pathname};
   }'''
MAX_GALLERY_IMAGES = 18
GALLERY_PAGING_BUDGET = 8.0
GALLERY_STEP_TIMEOUT_MS = 700
GALLERY_READY_ATTEMPTS = 4
GALLERY_READY_INTERVAL_MS = 800
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


async def collect_gallery(page, state):
    """收集图文页的图集，按轮播计数器翻页补齐懒加载的图片。

    只在同一个作品内翻页：抖音的方向键翻到最后一张还会继续滑进推荐流，
    URL 一变就必须停，否则会把别人的作品混进这一条分享里。
    """
    state['stage'] = 'gallery'
    first = await page.evaluate(GALLERY_SCRIPT)
    origin_path = first.get('path') or ''
    if '/note/' not in origin_path:
        return [], 0
    # 首屏图片和计数器都是异步渲染的，实测 5 秒时可能两者都还是空。等到任
    # 意一个就绪再开始，否则会当成“没有图片”直接判失败。
    for _ in range(GALLERY_READY_ATTEMPTS):
        if (first.get('items') or []) or int(first.get('total') or 0) > 1:
            break
        await page.wait_for_timeout(GALLERY_READY_INTERVAL_MS)
        first = await page.evaluate(GALLERY_SCRIPT)
    ordered = {}
    for item in first.get('items') or []:
        ordered.setdefault(item['id'], item['url'])
    total = int(first.get('total') or 0)
    # 计数器读不到时不翻页：宁可只发首屏几张，也不能翻进推荐流。
    if total <= 1:
        return list(ordered.values())[:MAX_GALLERY_IMAGES], total
    target = min(total, MAX_GALLERY_IMAGES)
    deadline = time.monotonic() + GALLERY_PAGING_BUDGET
    for _ in range(target + 1):
        if len(ordered) >= target or time.monotonic() > deadline:
            break
        await page.keyboard.press('ArrowRight')
        await page.wait_for_timeout(GALLERY_STEP_TIMEOUT_MS)
        current = await page.evaluate(GALLERY_SCRIPT)
        # 计数器总数变了就说明已经滑进了推荐流的下一个作品，比只看 URL 灵敏：
        # 抖音在同一路径下就能换作品。
        if (current.get('path') or '') != origin_path or int(current.get('total') or 0) != total:
            logger.warning('Douyin gallery paging left the note; keeping %d images', len(ordered))
            break
        for item in current.get('items') or []:
            ordered.setdefault(item['id'], item['url'])
    # 轮播会预加载相邻几张，一次翻页可能多出好几个 id；按计数器截断，多出来
    # 的一定是这条作品之外的。
    return list(ordered.values())[:target], total


async def read_page(page, url, video_requests, state, video_sizes=None):
    video_sizes = video_sizes or {}
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
    common = {
        'title': data.get('title', ''), 'description': data.get('desc', ''),
        'author': data.get('author', ''), 'avatar_url': data.get('avatar', ''),
        'tags': data.get('tags', []),
    }
    if data.get('video'):
        return {'status': 'success', 'data': {
            'media_type': 'video', 'video_url': html.unescape(data['video']),
            'size': video_sizes.get(data['video'], 0),
            'cover': data.get('cover', ''), **common,
        }}
    # 没有视频流时可能是图文笔记。抖音图文页也带一个 video 元素（推荐流），
    # 所以只能靠视频地址是否可用来判断，不能数 video 标签。
    images, total = await collect_gallery(page, state)
    if images:
        logger.info('Douyin gallery extracted images=%d counter_total=%d', len(images), total)
        return {'status': 'success', 'data': {
            'media_type': 'images', 'video_url': '', 'images': images,
            'cover': images[0], **common,
        }}
    # 视频地址常常比首屏晚到。收集图集期间网络请求仍在累积，这里再看一眼，
    # 能把一部分"页面没加载完"的失败救回来，省掉 yt-dlp 那条降级路径。
    late = next((u for u in reversed(video_requests) if is_real_video_url(u)), '')
    if late:
        logger.info('Douyin late video resource found after gallery wait')
        return {'status': 'success', 'data': {
            'media_type': 'video', 'video_url': html.unescape(late),
            'size': video_sizes.get(late, 0),
            'cover': data.get('cover', ''), **common,
        }}
    # 判"已删除"必须排在元数据兜底之前。被删的页面上仍会留下推荐位封面之类的
    # 零碎元素，一旦先走了 metadata 分支，上游就会拿它去降级 yt-dlp，真正的原因
    # 又被 Unsupported URL 盖掉。
    marker = removed_marker(await page.evaluate('() => document.body?.innerText || ""'))
    if marker:
        logger.info('Douyin content removed at source: %s', marker)
        raise ValueError(f'{REMOVED_REASON_PREFIX}: 抖音提示「{marker}」')
    # 既没视频也没图集，但标题/作者/封面这些页面元数据往往已经拿到了。带着
    # 它们返回，让上游用 yt-dlp 取到视频后仍能拼出完整卡片；全丢掉的话卡片
    # 上只剩一个标题。
    if any(common.get(field) for field in ('title', 'author', 'description')) or data.get('cover'):
        logger.info('Douyin metadata-only result (no playable media on page)')
        return {'status': 'success', 'data': {
            'media_type': 'metadata', 'video_url': '', 'images': [],
            'cover': data.get('cover', ''), **common,
        }}
    raise ValueError('no_video_resource: 页面未返回视频资源（需检查页面类型或登录验证）')


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
            video_sizes = {}

            def capture(response):
                if 200 <= response.status < 400 and is_real_video_url(response.url):
                    if response.url not in video_requests:
                        video_requests.append(response.url)
                    try:
                        size = int(response.headers.get('content-length', '0'))
                        if size > 0:
                            video_sizes[response.url] = size
                    except (TypeError, ValueError):
                        pass

            page.on('response', capture)
            result = await read_page(page, req.url, video_requests, state, video_sizes)
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
