"""Render an illustrated daily report with each video's actual cover."""
import asyncio
import base64
import html
import re
from contextlib import suppress
from urllib.parse import urlsplit

COVERS = {}


def cover_url(value):
    url = str(value or '')
    if url.startswith('http://'):
        url = 'https://' + url[7:]
    if url.startswith('//'):
        url = 'https:' + url
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.username or parts.password or parts.port:
        raise ValueError('视频封面地址无效')
    if not parts.hostname or not (parts.hostname == 'hdslb.com' or parts.hostname.endswith('.hdslb.com')):
        raise ValueError('视频封面不在 B站图片域名')
    return url


async def load_cover(context, bvid):
    if not re.fullmatch(r'BV[0-9A-Za-z]{10}', bvid):
        raise ValueError('报告 BV 号无效')
    if bvid in COVERS:
        return COVERS[bvid]
    page = None
    try:
        async with asyncio.timeout(40):
            url = ''
            # Read only public cover metadata. This is never a video/media URL.
            with suppress(Exception):
                metadata = await context.request.get(
                    f'https://api.bilibili.com/x/web-interface/view?bvid={bvid}',
                    headers={'referer': f'https://www.bilibili.com/video/{bvid}'}, timeout=8000)
                payload = await metadata.json()
                if payload.get('code') == 0:
                    url = payload.get('data', {}).get('pic', '')
            if not url:
                page = await context.new_page()
                await page.goto(f'https://www.bilibili.com/video/{bvid}', wait_until='domcontentloaded', timeout=20000)
                try:
                    await page.wait_for_function("""() => window.__INITIAL_STATE__?.videoData?.pic ||
                      document.querySelector('meta[property="og:image"]')?.content""", timeout=8000)
                except Exception as error:
                    raise ValueError(f'{bvid} 网页未返回封面：{(await page.title())[:80]}') from error
                url = await page.evaluate("""() => window.__INITIAL_STATE__?.videoData?.pic ||
                  document.querySelector('meta[property="og:image"]').content""")
            # Only a static cover image is read. No media URL/video is fetched.
            response = await context.request.get(cover_url(url), timeout=10000, max_redirects=0)
            mime = response.headers.get('content-type', '').split(';')[0]
            if not response.ok or mime not in ('image/jpeg', 'image/png', 'image/webp'):
                raise ValueError(f'{bvid} 封面图片读取失败')
            image = await response.body()
            if len(image) > 5_000_000:
                raise ValueError('封面图片过大')
            data = f'data:{mime};base64,' + base64.b64encode(image).decode()
            if len(COVERS) >= 40:
                COVERS.pop(next(iter(COVERS)))
            COVERS[bvid] = data
            return data
    finally:
        if page is not None:
            with suppress(Exception):
                await asyncio.wait_for(page.close(), 3)


def esc(value):
    return html.escape(str(value or ''))


def report_html(text, items=None, covers=None):
    lines = text.splitlines()
    title = lines[0] if lines else '每日梗百科学习报告'
    items = items or []
    covers = covers or {}
    if items:
        cards = []
        for item in items:
            bvid = item['bvid']
            if bvid not in covers:
                raise ValueError(f'{bvid} 缺少封面，不能发送缺图日报')
            learned = item.get('status') == 'learned'
            rows = [('学到的梗', item.get('term')), ('含义与出处', item.get('meaning')),
                    ('适用场景', '；'.join(item.get('usage') or [])),
                    ('可以怎样接', '；'.join(item.get('replyHooks') or [])),
                    ('未确认原因', item.get('error') if not learned else ''),
                    ('音频', item.get('audioStatus') or '本次未学习音频')]
            details = ''.join(f'<div class="detail"><b>{esc(label)}</b><p>{esc(value)}</p></div>'
                              for label, value in rows if value)
            cards.append(f'''<section><div class="video"><img src="{esc(covers[bvid])}">
            <div><span class="badge {'ok' if learned else 'fail'}">{'已学会' if learned else '未确认'}</span>
            <h2>{esc(item.get('title'))}</h2><div class="duration">观看 {float(item.get('seconds') or 0):.0f} 秒</div></div></div>
            {details}<div class="url">https://www.bilibili.com/video/{esc(bvid)}</div></section>''')
        content = f'<div class="intro">{esc(chr(10).join(lines[1:3]))}</div>' + ''.join(cards)
        # The structured report keeps summary/progress separate from video cards.
        tail = [line for line in lines[3:] if line.startswith(('累计', '学到：', '下次', '本轮', '今日总', '重试', '说明：'))]
        content += '<div class="progress">' + esc('\n'.join(tail)) + '</div>'
    else:
        content = '<div class="content">' + esc('\n'.join(lines[1:])) + '</div>'
    return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;padding:36px;background:#eef2f6;color:#192a3c;
    font-family:"Microsoft YaHei","Noto Sans CJK SC",sans-serif;width:1080px}
    main{background:white;border:1px solid #d7e1eb;border-radius:20px;padding:36px}
    .label{font-size:18px;letter-spacing:2px;color:#416e90;margin-bottom:16px}
    h1{font-size:32px;line-height:1.5;margin:0 0 26px;border-bottom:3px solid #4e8bab;padding-bottom:22px}
    .content,.intro,.progress{white-space:pre-wrap;overflow-wrap:anywhere;font-size:22px;line-height:1.8}
    .intro{color:#52697d;margin-bottom:28px}.progress{padding-top:26px}
    section{border:1px solid #d9e3ec;border-radius:14px;padding:24px;margin-top:24px;background:#fbfcfe}
    .video{display:flex;gap:24px;align-items:center;margin-bottom:20px}
    .video img{width:400px;height:225px;object-fit:contain;background:#e8eef4;border-radius:9px}
    .video>div{flex:1}h2{font-size:24px;line-height:1.6;margin:12px 0;overflow-wrap:anywhere}
    .badge{font-size:17px;border-radius:5px;padding:4px 10px}.ok{color:#146044;background:#e3f4ea}.fail{color:#925016;background:#fff0dc}
    .duration,.url{font-size:18px;color:#62758a}.url{margin-top:18px;overflow-wrap:anywhere}
    .detail{margin-top:14px;font-size:22px;line-height:1.8}.detail b{font-size:18px;color:#416e90}
    p{margin:3px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
    footer{font-size:16px;color:#62758a;margin-top:30px;padding-top:20px;border-top:1px solid #d7e1eb}
    </style><main><div class="label">梗百科 · 每日学习记录</div><h1>''' + esc(title) + '</h1>' + content + '''
    <footer>封面来自对应视频网页；学习结论以实际观看和记录为准。</footer></main></html>'''


async def render_report(browser, text, items=None, source_context=None):
    items = items or []
    covers = {}
    # At most ten cards; two recipients share the same cached cover bytes.
    slots = asyncio.Semaphore(2)
    async def get_cover(item):
        async with slots:
            covers[item['bvid']] = await load_cover(source_context, item['bvid'])
    await asyncio.gather(*(get_cover(item) for item in items))
    context = await browser.new_context(viewport={'width': 1080, 'height': 1000}, device_scale_factor=1)
    try:
        async with asyncio.timeout(20):
            await context.route('**/*', lambda route: route.abort())
            page = await context.new_page()
            await page.set_content(report_html(text, items, covers), wait_until='load')
            await page.evaluate('document.fonts.ready')
            await page.evaluate('Promise.all([...document.images].map(i => i.decode()))')
            height = await page.evaluate('document.documentElement.scrollHeight')
            if height > 25000:
                raise ValueError('报告过长，拒绝截断内容')
            return await page.screenshot(type='png', full_page=True, timeout=15000)
    finally:
        with suppress(Exception):
            await asyncio.wait_for(context.close(), 3)
