"""Repeat forwards must reuse the first cover so the card stays identical."""
import ast
import asyncio
import io
import logging
from pathlib import Path
import time
import unittest

import aiohttp
from aiohttp import web
from PIL import Image
from yarl import URL as YarlURL

main_path = Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/main.py'
source = ast.parse(main_path.read_text())
bridge = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
wanted = ('_cover_cache_key', '_cached_cover', '_remember_cover', '_cover_bytes')
methods = [n for n in bridge.body if getattr(n, 'name', '') in wanted]
constants = [
    n for n in source.body
    if isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '').startswith('COVER_')
]
# 取图路径依赖 signed_url 冻结签名地址的编码，一起带进来。
helper = next(n for n in source.body
              if isinstance(n, ast.FunctionDef) and n.name == 'signed_url')
namespace = {'asyncio': asyncio, 'aiohttp': aiohttp, 'time': time,
             'YarlURL': YarlURL, 'logger': logging.getLogger('test')}
module = ast.Module(
    body=[*constants, helper,
          ast.ClassDef(name='Bridge', bases=[], keywords=[], body=methods, decorator_list=[])],
    type_ignores=[],
)
exec(compile(ast.fix_missing_locations(module), '<bridge-cover>', 'exec'), namespace)
Bridge = namespace['Bridge']
namespace['COVER_FETCH_RETRY_SECONDS'] = 0


def jpeg_bytes(color='red', size=(330, 440)):
    buffer = io.BytesIO()
    Image.new('RGB', size, color).save(buffer, 'JPEG')
    return buffer.getvalue()


class CoverCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.image = jpeg_bytes()
        self.hits = []
        # 默认：第一次给图，之后一律 403（抖音签名域名的实测表现）。
        self.deny_after = 1

        async def handler(request):
            self.hits.append(request.path_qs)
            if len(self.hits) > self.deny_after:
                return web.Response(status=403, text='<!DOCTYPE html><html>403</html>',
                                    content_type='text/html')
            return web.Response(body=self.image, content_type='image/jpeg')

        app = web.Application()
        app.router.add_get('/cover.jpeg', handler)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, '127.0.0.1', 0)
        await self.site.start()
        port = self.runner.addresses[0][1]
        self.base = f'http://127.0.0.1:{port}/cover.jpeg'
        self.bridge = Bridge()
        self.bridge.cover_cache = {}
        self.bridge.session = aiohttp.ClientSession()

    async def asyncTearDown(self):
        await self.bridge.session.close()
        await self.runner.cleanup()

    async def test_second_forward_reuses_cover_without_hitting_cdn(self):
        """第二次转发同一条视频：签名变了，但缓存按路径命中，不再请求 CDN。"""
        first = await self.bridge._cover_bytes(f'{self.base}?x-signature=AAA', {})
        self.assertEqual(first, self.image)
        self.assertEqual(len(self.hits), 1)
        # 换签名，等同于重新解析后拿到的新地址。
        second = await self.bridge._cover_bytes(f'{self.base}?x-signature=BBB', {})
        self.assertEqual(second, first, '第二次的封面必须和第一次逐字节相同')
        self.assertEqual(len(self.hits), 1, '命中缓存时不应产生新的 CDN 请求')

    async def test_transient_rejection_is_retried(self):
        """首次就被拒时重试；实测同一地址会先 403 后 200。"""
        self.deny_after = 0
        calls = {'n': 0}
        original = self.image

        async def handler(request):
            calls['n'] += 1
            if calls['n'] < 3:
                return web.Response(status=403, text='<html>403</html>', content_type='text/html')
            return web.Response(body=original, content_type='image/jpeg')

        app = web.Application()
        app.router.add_get('/c.jpeg', handler)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        port = runner.addresses[0][1]
        try:
            got = await self.bridge._cover_bytes(f'http://127.0.0.1:{port}/c.jpeg', {})
            self.assertEqual(got, original)
            self.assertEqual(calls['n'], 3, '前两次 403 应各触发一次重试')
        finally:
            await runner.cleanup()

    async def test_exhausted_retries_return_empty_not_error_page(self):
        """全部失败时返回空字节，让渲染侧出无封面卡片。"""
        self.deny_after = 0
        got = await self.bridge._cover_bytes(f'{self.base}?x-signature=AAA', {})
        self.assertEqual(got, b'')
        self.assertEqual(len(self.hits), namespace['COVER_FETCH_ATTEMPTS'])
        self.assertEqual(self.bridge.cover_cache, {}, '失败结果不能进缓存')

    async def test_html_body_with_200_status_is_rejected(self):
        """状态码 200 但内容是错误页时也不能当封面。"""
        async def handler(request):
            return web.Response(status=200, text='<html>nope</html>', content_type='text/html')

        app = web.Application()
        app.router.add_get('/c.jpeg', handler)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        port = runner.addresses[0][1]
        try:
            self.assertEqual(await self.bridge._cover_bytes(f'http://127.0.0.1:{port}/c.jpeg', {}), b'')
        finally:
            await runner.cleanup()

    async def test_cache_key_ignores_signature_and_keeps_path(self):
        key = self.bridge._cover_cache_key
        stable = 'https://p3-pc-sign.douyinpic.com/tos-cn-i-0813/o8eQ~tplv-75:330.jpeg'
        self.assertEqual(key(f'{stable}?x-signature=AAA&x-expires=1'), stable)
        self.assertEqual(key(f'{stable}?x-signature=BBB&x-expires=2'), stable)
        self.assertNotEqual(key(stable), key(stable.replace('o8eQ', 'other')))

    async def test_expired_entry_is_refetched(self):
        await self.bridge._cover_bytes(f'{self.base}?x-signature=AAA', {})
        key = self.bridge._cover_cache_key(self.base)
        stored_at, payload = self.bridge.cover_cache[key]
        self.bridge.cover_cache[key] = (
            stored_at - namespace['COVER_CACHE_TTL_SECONDS'] - 1, payload,
        )
        self.deny_after = 99
        await self.bridge._cover_bytes(f'{self.base}?x-signature=CCC', {})
        self.assertEqual(len(self.hits), 2, '过期后应重新下载')

    async def test_gallery_previews_are_retried_not_left_blank(self):
        """图集预览走同一条取图路径：短时 403 要重试，不能直接留灰格。"""
        calls = {'n': 0}
        image = self.image

        async def handler(request):
            calls['n'] += 1
            if calls['n'] < 3:
                return web.Response(status=403, text='<html>403</html>',
                                    content_type='text/html')
            return web.Response(body=image, content_type='image/jpeg')

        app = web.Application()
        app.router.add_get('/p.jpeg', handler)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        port = runner.addresses[0][1]
        try:
            got = await self.bridge._cover_bytes(
                f'http://127.0.0.1:{port}/p.jpeg', {}, label='图文预览',
            )
            self.assertEqual(got, image)
            self.assertEqual(calls['n'], 3)
        finally:
            await runner.cleanup()

    async def test_repeat_forward_reuses_every_preview(self):
        """同一条图文再次转发时每张预览都命中缓存，卡片和第一次一致。"""
        first = await self.bridge._cover_bytes(
            f'{self.base}?x-signature=AAA', {}, label='图文预览',
        )
        self.deny_after = 0  # CDN 之后一律拒绝
        second = await self.bridge._cover_bytes(
            f'{self.base}?x-signature=ZZZ', {}, label='图文预览',
        )
        self.assertEqual(second, first)
        self.assertEqual(len(self.hits), 1)

    async def test_cache_is_bounded(self):
        for index in range(namespace['COVER_CACHE_MAX_ENTRIES'] + 10):
            self.bridge._remember_cover(f'https://cdn.example/{index}.jpeg', b'x')
        self.assertLessEqual(len(self.bridge.cover_cache), namespace['COVER_CACHE_MAX_ENTRIES'])


if __name__ == '__main__':
    unittest.main()
