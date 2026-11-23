"""Public card search, independent of the download provider and account state."""
import html
import re
import unicodedata
from urllib.parse import urlencode


def normalized_title(value):
    return ' '.join(unicodedata.normalize('NFKC', str(value or '')).split())


def search_title(value):
    # Search indexes treat punctuation differently; identity checks retain it.
    return ' '.join(''.join(c if c.isalnum() or c.isspace() else ' ' for c in value).split())


async def card_candidates(browser, title, author=""):
    title = normalized_title(title)
    if not 2 <= len(title) <= 200:
        raise ValueError('invalid card title')
    author = normalized_title(author)
    if len(author) > 80:
        raise ValueError('invalid uploader')
    context = await browser.new_context(viewport={'width': 1280, 'height': 900})
    page = None
    try:
        page = await context.new_page()
        query = search_title(title) + (' ' + author if author else '')
        await page.goto('https://search.bilibili.com/all?' + urlencode({'keyword': query}),
                        wait_until='domcontentloaded', timeout=25000)
        # Let the site's normal browser session initialize before reading its API.
        await page.wait_for_selector('.bili-video-card', timeout=15000)
        async def api(path):
            response = await context.request.get('https://api.bilibili.com' + path,
                headers={'referer': 'https://www.bilibili.com/'}, timeout=10000)
            if not response.ok:
                raise ValueError('public Bilibili API unavailable')
            body = await response.json()
            if body.get('code') != 0 or not body.get('data'):
                raise ValueError('public Bilibili API unavailable')
            return body['data']
        found = {}
        for page_number in (1, 2):
            data = await api('/x/web-interface/search/type?' + urlencode({
                'search_type': 'video', 'keyword': query, 'page': page_number, 'page_size': 20}))
            for row in data.get('result') or []:
                if not isinstance(row, dict):
                    continue
                name = normalized_title(html.unescape(re.sub(r'<[^>]*>', '', row.get('title', ''))))
                if name == title and re.fullmatch(r'BV[0-9A-Za-z]{10}', str(row.get('bvid', ''))):
                    found[row['bvid']] = row
            if int(data.get('numPages') or 1) <= page_number:
                break
        if len(found) > 3:
            raise ValueError('too many identical titles')
        candidates = []
        for bvid in found:
            data = await api('/x/web-interface/view?' + urlencode({'bvid': bvid}))
            if data.get('bvid') != bvid or normalized_title(data.get('title')) != title:
                continue
            candidates.append({'bvid': bvid, 'title': data['title'],
                'author': (data.get('owner') or {}).get('name', ''), 'cover': data.get('pic', ''),
                'pages_count': len(data.get('pages') or [])})
        return {'candidates': candidates}
    finally:
        await context.close()


async def main():
    import asyncio
    import json
    import os
    import sys
    from playwright.async_api import async_playwright
    sys.stdout.reconfigure(encoding='utf-8')
    body = json.load(sys.stdin)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=True, channel=os.environ.get('MEDIA_BROWSER_CHANNEL') or None)
        try:
            result = await asyncio.wait_for(card_candidates(
                browser, body.get('title', ''), body.get('author', '')), 55)
            print(json.dumps(result, ensure_ascii=False))
        finally:
            await browser.close()


if __name__ == '__main__':
    import asyncio
    asyncio.run(main())
