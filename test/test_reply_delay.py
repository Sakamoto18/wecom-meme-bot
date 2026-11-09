"""Execute the bridge pacing methods without requiring a running QQ adapter."""
import ast
import asyncio
import logging
import os
from pathlib import Path
import random
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

source = ast.parse((Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/main.py').read_text())
bridge = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
methods = [n for n in bridge.body if getattr(n, 'name', '') in ('_reply_delay_window', '_sleep_before_reply')]
namespace = dict(asyncio=asyncio, os=os, random=random, AstrMessageEvent=object, logger=logging.getLogger('delay-test'))
exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(
    name='Bridge', bases=[], keywords=[], body=methods, decorator_list=[],
)], type_ignores=[])), '<bridge-delay>', 'exec'), namespace)


class ReplyDelayTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.bridge = namespace['Bridge']()
        self.bridge.config = {}
        self.event = SimpleNamespace(is_private_chat=lambda: False, get_group_id=lambda: 'one')
        env = patch.dict(os.environ, {}, clear=True)
        env.start()
        self.addCleanup(env.stop)

    async def test_fresh_and_cached_media_and_error_notices_skip_random_delay(self):
        with patch.object(asyncio, 'sleep', new_callable=AsyncMock) as sleep:
            for mode in ('media', 'media-gallery', 'media-unavailable', 'management-relation-import'):
                for cached in (False, True):
                    await self.bridge._sleep_before_reply(self.event, {
                        'mode': mode, 'cached': cached, 'messages': [{'type': 'text', 'text': 'result'}],
                    })
            sleep.assert_not_awaited()

    async def test_chat_keeps_existing_delay_and_silent_observations_do_not_sleep(self):
        with patch.object(asyncio, 'sleep', new_callable=AsyncMock) as sleep, patch.object(random, 'uniform', return_value=30) as sample:
            await self.bridge._sleep_before_reply(self.event, {'mode': 'chat', 'messages': [{'type': 'text'}]})
            sample.assert_called_once_with(15, 45)
            sleep.assert_awaited_once_with(30)
            sleep.reset_mock()
            await self.bridge._sleep_before_reply(self.event, {'messages': []})
            self.bridge.config['reply_delay_enabled'] = False
            await self.bridge._sleep_before_reply(self.event, {'messages': [{'type': 'text'}]})
            sleep.assert_not_awaited()

    async def test_group_repeat_skips_even_explicitly_configured_delay(self):
        with patch.dict(os.environ, {
            'LONGTU_QQ_REPLY_DELAY_ENABLED': 'true',
            'LONGTU_QQ_REPLY_DELAY_MIN_SECONDS': '60',
            'LONGTU_QQ_REPLY_DELAY_MAX_SECONDS': '60',
        }), patch.object(asyncio, 'sleep', new_callable=AsyncMock) as sleep:
            for text in ('+1', '这也太巧了'):
                with self.subTest(text=text):
                    await self.bridge._sleep_before_reply(self.event, {
                        'mode': 'repeat-reply',
                        'messages': [{'type': 'text', 'text': text}],
                        'active_reply': True,
                        'active_reply_priority': 'may',
                    })
                    sleep.assert_not_awaited()
            await self.bridge._sleep_before_reply(self.event, {
                'mode': 'chat',
                'messages': [{'type': 'text', 'text': '+1'}],
                'active_reply': True,
                'active_reply_priority': 'may',
            })
            sleep.assert_awaited_once_with(60)

    async def test_three_media_groups_finish_while_chat_waits(self):
        started, finish = asyncio.Event(), asyncio.Event()
        async def sleep(delay):
            started.set()
            await finish.wait()
        with patch.object(asyncio, 'sleep', side_effect=sleep):
            chat = asyncio.create_task(self.bridge._sleep_before_reply(self.event, {'mode': 'chat', 'messages': [{}]}))
            try:
                await asyncio.wait_for(started.wait(), .5)
                await asyncio.wait_for(asyncio.gather(*[
                    self.bridge._sleep_before_reply(
                        SimpleNamespace(is_private_chat=lambda: False, get_group_id=lambda: group),
                        {'mode': 'media', 'messages': [{'type': 'video'}]},
                    ) for group in ('one', 'two', 'three')
                ]), .5)
                self.assertFalse(chat.done())
            finally:
                finish.set()
                await chat
