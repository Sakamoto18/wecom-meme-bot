"""Exercise the actual Bridge methods without an AstrBot runtime."""
from __future__ import annotations
import ast
import asyncio
import base64
import copy
import logging
import os
from pathlib import Path
import re
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, ANY

SOURCE = ast.parse((Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/main.py').read_text())
CLASS = next(n for n in SOURCE.body if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
METHODS = {'_compact_forward_value', '_format_forward_segments', '_format_forward_nodes',
           '_normalize_forward_image_base64', '_download_forward_image', '_forward_image_base64',
           '_get_image_circuit_open', '_note_get_image_failure', '_fetch_forward_nodes',
           '_collect_forward_images', '_fetch_forward_content'}
NS = dict(asyncio=asyncio, base64=base64, copy=copy, os=os, re=re, time=time,
          logger=logging.getLogger('forward-test'), signed_url=lambda url: url,
          aiohttp=SimpleNamespace(ClientTimeout=lambda **kw: kw))
for node in SOURCE.body:
    if isinstance(node, ast.Assign) and all(isinstance(t, ast.Name) for t in node.targets):
        try:
            value = ast.literal_eval(node.value)
        except (ValueError, TypeError):
            if all(t.id in {'MAX_FORWARD_IMAGE_BYTES', 'FORWARD_CACHE_TTL_SECONDS'} for t in node.targets):
                exec(compile(ast.Module(body=[node], type_ignores=[]), '<constants>', 'exec'), NS)
            continue
        for target in node.targets:
            NS[target.id] = value
tree = ast.Module(body=[ast.ClassDef(name='Bridge', bases=[], keywords=[],
    body=[n for n in CLASS.body if getattr(n, 'name', '') in METHODS], decorator_list=[])], type_ignores=[])
exec(compile(ast.fix_missing_locations(tree), '<bridge>', 'exec'), NS)
Bridge = NS['Bridge']

def node(*segments):
    return {'sender': {'nickname': '成员'}, 'message': list(segments)}

def text(value):
    return {'type': 'text', 'data': {'text': value}}

def image(value):
    return {'type': 'image', 'data': {'url': value}}

class Response:
    status = 200
    content_length = None
    def __init__(self, chunks):
        self.chunks = chunks
        self.content = self
    async def __aenter__(self): return self
    async def __aexit__(self, *_): pass
    async def read(self, _limit=None): return self.chunks[0]
    async def iter_chunked(self, _size):
        for chunk in self.chunks: yield chunk

class ForwardTests(unittest.IsolatedAsyncioTestCase):
    def bridge(self):
        b = Bridge()
        b.forward_cache = {}; b.forward_nodes_cache = {}
        b.get_image_failures = 0; b.get_image_circuit_until = 0
        return b

    async def test_download_consumes_every_chunk_not_only_first_read(self):
        b = self.bridge()
        chunks = [b'\xff\xd8' + b'a' * 16382, b'b' * 20000, b'\xff\xd9']
        b.session = SimpleNamespace(closed=False, get=lambda *_a, **_k: Response(chunks))
        result = await b._download_forward_image('https://example.com/image.jpg')
        self.assertEqual(base64.b64decode(result), b''.join(chunks))

    async def test_stream_size_limit_rejects_without_returning_partial_image(self):
        b = self.bridge()
        original = NS['MAX_FORWARD_IMAGE_BYTES']; NS['MAX_FORWARD_IMAGE_BYTES'] = 12
        b.session = SimpleNamespace(closed=False, get=lambda *_a, **_k: Response([b'a' * 10, b'b' * 10]))
        try: self.assertEqual(await b._download_forward_image('https://example.com/image.jpg'), '')
        finally: NS['MAX_FORWARD_IMAGE_BYTES'] = original

    async def test_full_32_message_19_image_record_reaches_formatter(self):
        b = self.bridge()
        nodes = [node(text(f'正文{i}')) for i in range(13)] + [node(image(str(i))) for i in range(19)]
        async def read(_event, data): return base64.b64encode(data['url'].encode()).decode()
        b._forward_image_base64 = read
        b._fetch_forward_nodes = AsyncMock(return_value=nodes)
        record, images = await b._fetch_forward_content(SimpleNamespace(get_group_id=lambda:'test'), 'id', refresh=True)
        self.assertEqual(len(images), 19)
        self.assertEqual(record.count('\n') + 1, 32)
        self.assertIn('[图片#19]', record)
        self.assertNotIn('已截断', record)
        b._fetch_forward_nodes.assert_awaited_once_with(ANY, 'id', refresh=True)

    async def test_download_failure_does_not_shift_picture_attribution(self):
        b = self.bridge()
        nodes = [node(text('甲'), image('first')), node(text('乙'), image('failed')), node(text('丙'), image('third'))]
        b._forward_image_base64 = AsyncMock(side_effect=['YQ==', '', 'Yw=='])
        images = await b._collect_forward_images(None, nodes)
        record = b._format_forward_nodes(nodes)
        self.assertEqual(images, ['YQ==', 'Yw=='])
        self.assertIn('甲 [图片#1]', record)
        self.assertIn('乙 [图片未读取：下载失败]', record)
        self.assertIn('丙 [图片#2]', record)

    async def test_refresh_replaces_cached_expired_urls_and_accepts_api_envelope(self):
        b = self.bridge(); b.forward_nodes_cache['id'] = (time.monotonic(), [node(image('expired'))])
        fresh = [node(image('fresh'))]
        bot = SimpleNamespace(call_action=AsyncMock(return_value={'data': {'messages': fresh}}))
        event = SimpleNamespace(bot=bot, message_obj=SimpleNamespace(self_id='bot'))
        self.assertEqual(await b._fetch_forward_nodes(event, 'id', refresh=True), fresh)
        bot.call_action.assert_awaited_once()

    async def test_nested_forward_text_and_image_use_same_tree(self):
        b = self.bridge()
        nested = [node(text('嵌套正文'), image('nested'))]
        nodes = [node({'type':'forward','data':{'id':'inner'}})]
        b._fetch_forward_nodes = AsyncMock(return_value=nested)
        b._forward_image_base64 = AsyncMock(return_value='YQ==')
        self.assertEqual(await b._collect_forward_images(None, nodes), ['YQ=='])
        record = b._format_forward_nodes(nodes)
        self.assertIn('嵌套正文', record); self.assertIn('[图片#1]', record)

    async def test_exceeding_image_limit_is_explicit(self):
        b = self.bridge(); nodes = [node(image(str(i))) for i in range(25)]
        b._forward_image_base64 = AsyncMock(return_value='YQ==')
        self.assertEqual(len(await b._collect_forward_images(None, nodes)), 24)
        self.assertIn('超过 24 张图片', b._format_forward_nodes(nodes))

if __name__ == '__main__': unittest.main()
