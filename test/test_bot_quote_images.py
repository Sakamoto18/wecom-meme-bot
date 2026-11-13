from __future__ import annotations
import ast
import asyncio
import contextlib
import logging
import re
import sys
import time
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

source = ast.parse((Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/main.py').read_text())
bridge = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
names = {
    '_quoted_visual_chain', '_quoted_author', '_quoted_text', '_reply_component',
    '_image_base64s', '_components_from_raw_message', '_quoted_message_chain',
    '_reply_chains_from_backend', '_recent_image_cache_key',
    '_remember_outbound_image', '_outbound_images_for_quote',
    '_cache_recent_images', '_recent_image_candidates',
    '_relation_import_key', '_relation_import_active', '_update_relation_import',
    'on_qq_message',
}
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

namespace = {'__name__': 'astrbot_plugin_longtu_bridge.quote_test', '__package__': 'astrbot_plugin_longtu_bridge', 'Comp': SimpleNamespace(Plain=Plain, Image=Image, Reply=Reply, Forward=Forward),
             'asyncio': asyncio, 'contextlib': contextlib, 're': re, 'time': time,
             'logger': logging.getLogger('test'), 'MAX_IMAGE_COMPONENTS': 12, 'MAX_FORWARD_IMAGE_COMPONENTS': 24,
             'MAX_QUOTED_REPLY_DEPTH': 3,
             'OUTBOUND_IMAGE_MAX_BASE64_CHARACTERS': 100000,
             'OUTBOUND_IMAGE_CACHE_MAX_TOTAL_BASE64_CHARACTERS': 100000,
             'OUTBOUND_IMAGE_CACHE_TTL_SECONDS': 1800,
             'OUTBOUND_IMAGE_CACHE_MAX_ENTRIES': 128,
             'RECENT_IMAGE_CACHE_MAX_BASE64_CHARACTERS': 100000,
             'RECENT_IMAGE_CACHE_MAX_ENTRIES': 128,
             'RECENT_IMAGE_REFERENCE_PATTERN': re.compile(r'(?:上面|刚才|前面|上一张|前一张|这张(?:图|图片)|这个(?:图|图片)|图里|图片里)'),
             'MEDIA_SHARE_PATTERN': re.compile(r'https?://'),
             'MEDIA_ACK_PATTERN': re.compile(r'https?://'),
             'NATIVE_QQ_VIDEO_PATTERN': re.compile(r'qq\.com'),
             'PURE_BOT_MENTION_TEXT': '纯艾特'}
exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='Bridge', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])), '<bridge>', 'exec'), namespace)
Bridge = namespace['Bridge']

class QuoteImageTests(unittest.IsolatedAsyncioTestCase):
    def test_outbound_card_cache_recovers_only_by_quote_id(self):
        instance = Bridge()
        instance.outbound_image_cache = {}
        instance.outbound_latest_image_cache = {}
        event = SimpleNamespace(
            is_private_chat=lambda: False,
            get_group_id=lambda: '1109147947',
            get_sender_id=lambda: 'user',
        )
        encoded = 'Y2FyZC1pbWFnZQ=='
        instance._remember_outbound_image(event, {'data': {'message_id': 'card-1'}}, encoded)
        self.assertEqual(instance._outbound_images_for_quote(SimpleNamespace(id='card-1')), [encoded])
        self.assertEqual(instance._outbound_images_for_quote(SimpleNamespace(id='unrelated')), [])

    def test_raw_onebot_sub_type_is_preserved_for_quote_filtering(self):
        components = Bridge._components_from_raw_message([{
            'type': 'image',
            'data': {'file': 'base64://dragon', 'sub_type': 1, 'summary': '[龙图]'},
        }])
        self.assertEqual(getattr(components[0], '_longtu_image_sub_type', None), 1)
        self.assertEqual(getattr(components[0], '_longtu_image_summary', None), '[龙图]')

    async def test_bot_quote_hydrates_onebot_sub_type_before_visual_filter(self):
        quoted = Reply('bot', [Image('preview')])
        event = SimpleNamespace(
            get_self_id=lambda: 'bot',
            message_obj=SimpleNamespace(self_id='bot'),
            bot=SimpleNamespace(call_action=AsyncMock(return_value={
                'data': {
                    'sender': {'user_id': 'bot', 'nickname': '龙玉涛'},
                    'message': [{
                        'type': 'image',
                        'data': {'file': 'base64://card', 'sub_type': 0},
                    }],
                },
            })),
        )
        instance = Bridge()
        chain = await instance._quoted_message_chain(event, quoted, quoted.chain)
        self.assertEqual(getattr(quoted, '_longtu_quoted_image_sub_types', None), ['0'])
        visual = Bridge._quoted_visual_chain(event, quoted, chain, '解释一下这张图')
        self.assertEqual(len(visual), 1)

    async def run_message(self, author='bot', current_image=False, text='你刚刚这句什么意思', fetched_author=None, quoted_sub_type='1', importing=False, no_quote=False, rich_segments=None):
        quoted = Reply(author, [Plain('原来的文字回答'), Image('quoted-meme')])
        quoted._longtu_quoted_image_sub_types = [str(quoted_sub_type)]
        components = [Plain(text)] + ([] if no_quote else [quoted]) + ([Image('new-user-image')] if current_image else [])
        event = SimpleNamespace(get_self_id=lambda:'bot', get_sender_id=lambda:'user',
            get_sender_name=lambda:'用户', get_group_id=lambda:'1109147947',
            is_private_chat=lambda:False, get_messages=lambda:components,
            message_obj=SimpleNamespace(message_id='new-message'), message_str=text,
            stop_event=Mock())
        instance = Bridge(); instance.config = {}; instance.media_status_cache = {}
        if importing:
            instance._update_relation_import(event, {'relation_import': {'active': True, 'expires_at': time.time() * 1000 + 900000}})
        instance._group_is_allowed = lambda _event: True
        instance._is_slash_command = lambda _event: False
        instance._is_allowed_bridge_slash_command = lambda _event: False
        instance._should_reply = lambda _event: not importing
        instance._raw_text = lambda _event: text
        async def hydrate(_event, reply, chain):
            if fetched_author: reply._longtu_quoted_user_id = fetched_author
            return chain
        instance._quoted_message_chain = hydrate
        instance._forward_components = lambda _chain: []
        instance._rich_segments = lambda *_args: rich_segments or []
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
        instance._recent_group_context = AsyncMock(return_value={})
        instance._sleep_before_reply = AsyncMock()
        instance._mentions = lambda _components: []
        instance._request_backend = AsyncMock(return_value={'mode': 'observed', 'messages': []})
        instance._send_forward_from_backend = AsyncMock(return_value=False)
        instance._reply_chain_from_backend = lambda _response: []
        # Exercise image/media routing without importing AstrBot's progress UI.
        async def request_backend(bridge, _event, payload):
            return await bridge._request_backend(payload)
        with patch.dict(sys.modules, {'astrbot_plugin_longtu_bridge.web_learning_progress':
                SimpleNamespace(request_learning_backend=request_backend, deliver_learning_report=AsyncMock(return_value=False))}):
            async for _ in instance.on_qq_message(event): pass
        event.stop_event.assert_called_once()
        return instance._request_backend.call_args.args[0], read_images, instance

    async def test_new_share_does_not_recall_recent_user_or_bot_images(self):
        for rich in (False, True):
            with self.subTest(rich=rich):
                payload, downloads, instance = await self.run_message(
                    no_quote=True,
                    text='8.76 复制打开抖音，看看【半口小希的作品】不喜欢我的让一让 让喜欢我的到前面来'
                    + ('' if rich else ' https://v.douyin.com/mKvAs1y9img/'),
                    rich_segments=[{'type': 'json', 'data': {'data': 'https://v.douyin.com/mKvAs1y9img/'}}] if rich else [],
                )
                self.assertTrue(payload['media_share'])
                self.assertFalse(payload['bot_generated_image_only'])
                self.assertFalse(payload['has_image'])
                self.assertEqual(downloads, [])
                instance._recent_images_for_reference.assert_not_called()

    def test_cached_candidates_keep_authors_and_never_become_current_images(self):
        instance = Bridge()
        def event(user, mid, text):
            return SimpleNamespace(is_private_chat=lambda: False, get_group_id=lambda: 'g',
                get_sender_id=lambda: user, get_sender_name=lambda: user,
                message_obj=SimpleNamespace(message_id=mid), message_str=text)
        instance._cache_recent_images(event('asker', 'a', '自己的图'), ['YQ=='])
        instance._cache_recent_images(event('other', 'b', '别人插图'), ['Yg=='])
        context = instance._recent_image_candidates(event('asker', 'question', '配色有问题吗'))
        self.assertEqual([row['user_id'] for row in context['messages']], ['asker', 'other'])
        self.assertEqual([row['message_id'] for row in context['images']], ['a', 'b'])

    async def test_plain_prose_with_reference_words_never_attaches_stale_image(self):
        for text in ['前面路口右转', '刚才吃了个饭', '这个配色太艳了吗']:
            payload, _, instance = await self.run_message(no_quote=True, text=text)
            self.assertFalse(payload['has_image'])
            self.assertFalse(payload['bot_generated_image_only'])
            instance._recent_images_for_reference.assert_not_called()

    async def test_active_import_wakes_group_image_without_at_and_keeps_quoted_sticker(self):
        payload, downloads, instance = await self.run_message(importing=True, current_image=True, text='')
        self.assertFalse(payload['observe_only'])
        self.assertEqual(downloads, ['new-user-image', 'quoted-meme'])
        self.assertEqual(payload['quoted_image_base64s'], ['quoted-meme'])
        instance._recent_images_for_reference.assert_not_called()

    def test_import_state_is_scoped_to_sender_and_group_and_expires(self):
        instance = Bridge()
        def event(group='g1', sender='admin', private=False):
            return SimpleNamespace(is_private_chat=lambda:private, get_group_id=lambda:group, get_sender_id=lambda:sender)
        instance._update_relation_import(event(), {'relation_import': {'active': True, 'expires_at': time.time()*1000 + 900000}})
        self.assertTrue(instance._relation_import_active(event()))
        self.assertFalse(instance._relation_import_active(event('g2')))
        self.assertFalse(instance._relation_import_active(event(sender='other')))
        self.assertFalse(instance._relation_import_active(event(private=True)))
        instance._update_relation_import(event(), {'relation_import': {'active': False}})
        self.assertFalse(instance._relation_import_active(event()))
        instance._update_relation_import(event(), {'relation_import': {'active': True, 'expires_at': 1}})
        self.assertFalse(instance._relation_import_active(event()))

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

    async def test_bot_quote_keeps_regular_generated_image_for_vision(self):
        payload, downloads, _ = await self.run_message(quoted_sub_type='0')
        self.assertEqual(payload['quoted_image_base64s'], ['quoted-meme'])
        self.assertTrue(payload['has_image'])
        self.assertEqual(downloads, ['quoted-meme'])

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
