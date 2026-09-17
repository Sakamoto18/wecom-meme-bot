"""aiohttp must not re-encode signed CDN URLs.

抖音图片的 x-signature 是 base64，含 / 时 URL 编码为 %2F。aiohttp 用 yarl
规范化 URL 时会把 query 里的 %2F 解码回 /，签名随之失配、CDN 返回 403。
实测一条 12 图的作品有 4 张签名含 %2F，卡片上就是 4 个灰格；视频封面同理，
约四分之一的分享会完全没有封面。而且同一地址每次都被同样改写，重试无用。
"""
import ast
import asyncio
import io
import logging
from pathlib import Path
import re
import time
import unittest

import aiohttp
from aiohttp import web
from PIL import Image
from yarl import URL as YarlURL

main_path = Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/main.py'
source = ast.parse(main_path.read_text())
helper = next(n for n in source.body
              if isinstance(n, ast.FunctionDef) and n.name == 'signed_url')
bridge = next(n for n in source.body
              if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
wanted = ('_cover_cache_key', '_cached_cover', '_remember_cover', '_cover_bytes')
methods = [n for n in bridge.body if getattr(n, 'name', '') in wanted]
constants = [n for n in source.body if isinstance(n, ast.Assign)
             and getattr(n.targets[0], 'id', '').startswith('COVER_')]
namespace = {'asyncio': asyncio, 'aiohttp': aiohttp, 'time': time, 're': re,
             'YarlURL': YarlURL, 'logger': logging.getLogger('test')}
module = ast.Module(
    body=[*constants, helper,
          ast.ClassDef(name='Bridge', bases=[], keywords=[], body=methods, decorator_list=[])],
    type_ignores=[],
)
exec(compile(ast.fix_missing_locations(module), '<bridge-signed>', 'exec'), namespace)
signed_url = namespace['signed_url']
Bridge = namespace['Bridge']
namespace['COVER_FETCH_RETRY_SECONDS'] = 0

# 真实形态：base64 签名里的 / 和 = 编码为 %2F、%3D
SIG_WITH_SLASH = 'BF1lf8wwqfq2EVTP2nW8%2FeVbjzI%3D'
SIG_PLAIN = 'rinoG5uK5C2EjQMgdE6apPacRPc%3D'


class SignedUrlTests(unittest.TestCase):
    def test_percent_2f_survives(self):
        raw = f'https://p3-pc-sign.douyinpic.com/x~tplv.webp?sc=image&x-signature={SIG_WITH_SLASH}'
        # 未处理时 yarl 会把 %2F 解码成 /，签名就变了。
        self.assertIn('/eVbjzI', str(YarlURL(raw)))
        self.assertNotIn('%2F', str(YarlURL(raw)))
        # 包一层后必须原样保留。
        self.assertIn('%2F', str(signed_url(raw)))
        self.assertEqual(str(signed_url(raw)), raw)

    def test_signatures_without_slash_are_unchanged_too(self):
        raw = f'https://p3-pc-sign.douyinpic.com/x~tplv.webp?x-signature={SIG_PLAIN}'
        self.assertEqual(str(signed_url(raw)), raw)

    def test_plus_and_equals_are_preserved(self):
        raw = 'https://cdn.example/a.webp?x-signature=ab%2Bcd%2Fef%3D%3D&k=v'
        self.assertEqual(str(signed_url(raw)), raw)

    def test_malformed_url_falls_back_to_string(self):
        # 不合法地址不能让取图整个抛出，交回字符串按老路处理。
        self.assertIsInstance(signed_url('not a url at all'), (str, YarlURL))
        self.assertIsInstance(signed_url(''), (str, YarlURL))


def jpeg_bytes():
    buffer = io.BytesIO()
    Image.new('RGB', (60, 80), 'red').save(buffer, 'JPEG')
    return buffer.getvalue()


class SignedFetchTests(unittest.IsolatedAsyncioTestCase):
    """起一个只接受未被改写签名的服务，等价于抖音 CDN 的行为。"""

    async def asyncSetUp(self):
        self.image = jpeg_bytes()
        self.seen = []

        async def handler(request):
            # 只有原样带着 %2F 抵达才算签名正确。aiohttp 改写过就会变成 /。
            raw_query = request.rel_url.raw_query_string
            self.seen.append(raw_query)
            if '%2F' not in raw_query:
                return web.Response(status=403, text='<html>403</html>',
                                    content_type='text/html')
            return web.Response(body=self.image, content_type='image/jpeg')

        app = web.Application()
        app.router.add_get('/img.webp', handler)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, '127.0.0.1', 0)
        await site.start()
        port = self.runner.addresses[0][1]
        self.url = f'http://127.0.0.1:{port}/img.webp?x-signature={SIG_WITH_SLASH}'
        self.bridge = Bridge()
        self.bridge.cover_cache = {}
        self.bridge.session = aiohttp.ClientSession()

    async def asyncTearDown(self):
        await self.bridge.session.close()
        await self.runner.cleanup()

    async def test_cover_with_slash_signature_now_succeeds(self):
        got = await self.bridge._cover_bytes(self.url, {})
        self.assertEqual(got, self.image, '签名含 %2F 的封面必须能取到')
        self.assertEqual(len(self.seen), 1, '一次就该成功，不该走到重试')

    async def test_gallery_preview_with_slash_signature_succeeds(self):
        got = await self.bridge._cover_bytes(self.url, {}, label='图文预览')
        self.assertEqual(got, self.image)

    async def test_raw_string_would_have_failed(self):
        """对照：不加保护时同一个地址拿不到，证明服务端判据有效。"""
        async with self.bridge.session.get(self.url) as response:
            self.assertEqual(response.status, 403)


if __name__ == '__main__':
    unittest.main()
