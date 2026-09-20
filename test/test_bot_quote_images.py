from __future__ import annotations
import ast
import asyncio
import contextlib
import logging
import re
import time
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

source = ast.parse((Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/main.py').read_text())
bridge = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
names = {'_quoted_visual_chain', '_quoted_author', '_quoted_text', '_reply_component', '_image_base64s', 'on_qq_message'}
methods = [n for n in bridge.body if getattr(n, 'name', '') in names]
for method in methods:
    if method.name == 'on_qq_message': method.decorator_list = []

class Plain:
    def __init__(self, text): self.text = text
class Image:
    def __init__(self, file): self.file = file
class Reply:
    def __init__(self, sender_id, chain):
        self.sender_id, self.chain, self.id = sender_id, chain, 'original-message'
class Forward: pass

namespace = {'Comp': SimpleNamespace(Plain=Plain, Image=Image, Reply=Reply, Forward=Forward),
             'asyncio': asyncio, 'contextlib': contextlib, 're': re, 'time': time,
             'logger': logging.getLogger('test'), 'MAX_IMAGE_COMPONENTS': 12,
             'MEDIA_SHARE_PATTERN': re.compile(r'https?://'),
             'MEDIA_ACK_PATTERN': re.compile(r'https?://'),
             'NATIVE_QQ_VIDEO_PATTERN': re.compile(r'qq\.com'),
             'PURE_BOT_MENTION_TEXT': '纯艾特'}
exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='Bridge', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])), '<bridge>', 'exec'), namespace)
Bridge = namespace['Bridge']

class QuoteImageTests(unittest.IsolatedAsyncioTestCase):
    async def run_message(self, author='bot', current_image=False, text='你刚刚这句什么意思', fetched_author=None):
        quoted = Reply(author, [Plain('原来的文字回答'), Image('quoted-meme')])
        components = [Plain(text), quoted] + ([Image('new-user-image')] if current_image else [])
        event = SimpleNamespace(get_self_id=lambda:'bot', get_sender_id=lambda:'user',
            get_sender_name=lambda:'用户', get_group_id=lambda:'1109147947',
            is_private_chat=lambda:False, get_messages=lambda:components,
            message_obj=SimpleNamespace(message_id='new-message'), message_str=text,
            stop_event=Mock())
        instance = Bridge(); instance.config = {}; instance.media_status_cache = {}
        instance._is_slash_command = lambda _event: False
        instance._is_allowed_bridge_slash_command = lambda _event: False
        instance._should_reply = lambda _event: True
        instance._raw_text = lambda _event: text
        async def hydrate(_event, reply, chain):
            if fetched_author: reply._longtu_quoted_user_id = fetched_author
            return chain
        instance._quoted_message_chain = hydrate
        instance._forward_components = lambda _chain: []
        instance._rich_segments = lambda *_args: []
        instance._media_group_enabled = lambda *_args: True
        instance._is_pure_bot_mention = lambda _event: False
        instance._text_for_backend = lambda _event, text, **_kwargs: text
        instance._forwarded_content = AsyncMock(return_value=('', []))
        read_images = []
        async def read_image(component):
            read_images.append(component.file)
            return component.file
        # _image_base64s is a classmethod and calls the class reader.
        Bridge._image_base64 = staticmethod(read_image)
        instance._cache_recent_images = Mock()
        instance._recent_images_for_reference = Mock(return_value=['stale-bot-image'])
        instance._group_info = AsyncMock(return_value={})
        instance._mentions = lambda _components: []
        instance._request_backend = AsyncMock(return_value={'mode': 'observed', 'messages': []})
        instance._send_forward_from_backend = AsyncMock(return_value=False)
        instance._reply_chain_from_backend = lambda _response: []
        async for _ in instance.on_qq_message(event): pass
        event.stop_event.assert_called_once()
        return instance._request_backend.call_args.args[0], read_images, instance

    async def test_bot_quote_keeps_text_without_downloading_or_recaching_its_meme(self):
        payload, downloads, bridge = await self.run_message()
        self.assertEqual(payload['quoted_text'], '原来的文字回答')
        self.assertEqual(payload['quoted_user_id'], 'bot')
        self.assertFalse(payload['has_image'])
        self.assertEqual(payload['quoted_image_base64s'], [])
        self.assertEqual(downloads, [])
        self.assertEqual(bridge._cache_recent_images.call_args.args[1], [])
        bridge._recent_images_for_reference.assert_not_called()

    async def test_new_user_image_still_downloaded_but_not_bot_meme(self):
        payload, downloads, _ = await self.run_message(current_image=True)
        self.assertEqual(downloads, ['new-user-image'])
        self.assertEqual(payload['image_base64s'], ['new-user-image'])
        self.assertEqual(payload['quoted_image_base64s'], [])

    async def test_other_user_quote_keeps_image(self):
        payload, downloads, _ = await self.run_message(author='human')
        self.assertEqual(downloads, ['quoted-meme'])
        self.assertEqual(payload['quoted_image_base64s'], ['quoted-meme'])

    async def test_author_recovered_from_onebot_is_used_for_filter(self):
        payload, downloads, _ = await self.run_message(author='', fetched_author='bot')
        self.assertEqual(payload['quoted_user_id'], 'bot')
        self.assertEqual(downloads, [])

    async def test_missing_author_does_not_guess_by_nickname_or_delete_user_image(self):
        payload, downloads, _ = await self.run_message(author='')
        self.assertEqual(downloads, ['quoted-meme'])

    async def test_library_commands_can_still_access_quoted_bot_image(self):
        for command in ['/add', '/tag 测试', '/del', '检查这张图']:
            payload, downloads, _ = await self.run_message(text=command)
            self.assertEqual(downloads, ['quoted-meme'], command)
            self.assertEqual(payload['quoted_image_base64s'], ['quoted-meme'])

if __name__ == '__main__': unittest.main()
