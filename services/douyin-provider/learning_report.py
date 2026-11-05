"""Render a complete learning report as a single image, using escaped text only."""
import asyncio
import html
from contextlib import suppress


def report_html(text):
    lines = text.splitlines()
    title = lines[0] if lines else '每日梗百科学习报告'
    content = '\n'.join(lines[1:])
    return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;padding:42px;background:#eef2f6;color:#192a3c;
    font-family:"Microsoft YaHei","Noto Sans CJK SC",sans-serif;width:1080px}
    main{background:white;border:1px solid #d7e1eb;border-radius:20px;padding:40px}
    .label{font-size:18px;letter-spacing:2px;color:#416e90;margin-bottom:16px}
    h1{font-size:32px;line-height:1.5;margin:0 0 26px;border-bottom:3px solid #4e8bab;padding-bottom:22px}
    .content{white-space:pre-wrap;overflow-wrap:anywhere;font-size:23px;line-height:1.85}
    footer{font-size:17px;color:#62758a;margin-top:30px;padding-top:20px;border-top:1px solid #d7e1eb}
    </style><main><div class="label">梗百科 · 每日学习记录</div><h1>''' + html.escape(title) + '</h1><div class="content">' + html.escape(content) + '''</div>
    <footer>来源、学习结果、未确认内容与续学位置均以本次记录为准。</footer></main></html>'''


async def render_report(browser, text):
    context = await browser.new_context(viewport={'width': 1080, 'height': 1000}, device_scale_factor=1)
    try:
        async with asyncio.timeout(20):
            await context.route('**/*', lambda route: route.abort())
            page = await context.new_page()
            await page.set_content(report_html(text), wait_until='load')
            await page.evaluate('document.fonts.ready')
            height = await page.evaluate('document.documentElement.scrollHeight')
            if height > 25000:
                raise ValueError('报告过长，拒绝截断内容')
            return await page.screenshot(type='png', full_page=True, timeout=15000)
    finally:
        with suppress(Exception):
            await asyncio.wait_for(context.close(), 3)
