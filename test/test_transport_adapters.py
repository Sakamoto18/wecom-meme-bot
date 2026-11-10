"""Contract tests using actual adapter modules, no network or QQ sends."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from astrbot_plugin_longtu_bridge.adapters import (
    Capabilities, DeliveryError, LegacyOneBotAdapter, OneBotAdapter, Target, transport_for,
)
from astrbot_plugin_longtu_bridge.adapters.types import delivery_receipt
from astrbot_plugin_longtu_bridge.video_delivery_cache import VideoDeliveryCache, VideoForwardRejected


class TransportTests(unittest.IsolatedAsyncioTestCase):
    def bot(self, result=None):
        return SimpleNamespace(call_action=AsyncMock(return_value=result or {'message_id': 19}))

    async def test_group_private_and_image_segments_match_compatibility_client(self):
        for target in (Target('group', '123'), Target('private', '456')):
            bots = [self.bot(), self.bot()]
            messages = [{'type': 'reply', 'data': {'id': '3'}},
                        {'type': 'text', 'data': {'text': '原文'}},
                        {'type': 'image', 'data': {'file': 'base64://abcd', 'sub_type': 1}}]
            for adapter, bot in zip((LegacyOneBotAdapter, OneBotAdapter), bots):
                self.assertEqual(await adapter(bot).send(target, messages), {'message_id': 19})
            self.assertEqual(bots[0].call_action.call_args, bots[1].call_action.call_args)
            self.assertEqual(bots[1].call_action.await_count, 1)
            self.assertEqual(messages[2]['data']['sub_type'], 1)

    async def test_quote_forward_image_history_routing_and_order(self):
        bot = self.bot()
        adapter = OneBotAdapter(bot)
        await adapter.read_message('message', self_id='9')
        await adapter.read_forward('forward', self_id='9')
        await adapter.read_image('file-ref', self_id='9')
        await adapter.history('123', 'before', 30)
        calls = bot.call_action.call_args_list
        self.assertEqual(calls[0].kwargs, {'action': 'get_msg', 'message_id': 'message', 'self_id': '9'})
        self.assertEqual(calls[1].kwargs['action'], 'get_forward_msg')
        self.assertEqual(calls[2].kwargs['file'], 'file-ref')
        self.assertEqual(calls[3].args, ('get_group_msg_history',))
        self.assertEqual(calls[3].kwargs, {'group_id': 123, 'message_seq': 'before', 'count': 30, 'reverseOrder': False})

    async def test_explicit_rejection_unknown_and_timeout_are_different(self):
        for result, outcome in ((None, 'unknown'), ({}, 'unknown'),
                                ({'retcode': 1200, 'message': 'SECRET'}, 'rejected')):
            bot = self.bot()
            bot.call_action.return_value = result
            with self.assertRaises(DeliveryError) as raised:
                await OneBotAdapter(bot).send(Target('group', '123'), [])
            self.assertEqual(raised.exception.outcome, outcome)
            self.assertNotIn('SECRET', str(raised.exception))
            self.assertEqual(bot.call_action.await_count, 1)
        bot = self.bot()
        bot.call_action.side_effect = asyncio.TimeoutError()
        with self.assertRaises(DeliveryError) as raised:
            await OneBotAdapter(bot).send_forward(Target('group', '123'), [])
        self.assertEqual(raised.exception.outcome, 'unknown')
        self.assertEqual(bot.call_action.await_count, 1)

    async def test_missing_capability_does_not_call_api(self):
        bot = self.bot()
        adapter = OneBotAdapter(bot, capabilities=Capabilities(reactions=False, history=False, native_forward=False))
        with self.assertRaises(DeliveryError):
            await adapter.react('1', '478')
        with self.assertRaises(DeliveryError):
            await adapter.history('123', '1', 30)
        with self.assertRaises(VideoForwardRejected):
            await adapter.forward_video(Target('group', '123'), '7')
        bot.call_action.assert_not_awaited()

    async def test_native_null_success_and_explicit_failure(self):
        bot = self.bot()
        adapter = OneBotAdapter(bot)
        bot.call_action.return_value = None
        result = await adapter.forward_video(Target('group', '123'), 77)
        self.assertEqual(result, {'delivery': 'native-forward', 'reused_message_id': 77})
        bot.call_action.return_value = {'status': 'failed', 'retcode': 1200}
        with self.assertRaises(VideoForwardRejected):
            await adapter.forward_video(Target('group', '123'), 77)
        bot.call_action.side_effect = asyncio.TimeoutError()
        with self.assertRaises(asyncio.TimeoutError):
            await adapter.forward_video(Target('group', '123'), 77)

    async def test_video_timeout_override_does_not_modify_shared_client(self):
        calls = []
        class Wrapper:
            def __init__(self): self._timeout_sec = 180
        class Api:
            def __init__(self):
                self._wsr_api = Wrapper()
                self._http_api = Wrapper()
            async def call_action(self, action, **kwargs):
                calls.append((action, kwargs, self._wsr_api._timeout_sec))
                return {'data': {'message_id': 123}}
        api = Api()
        bot = SimpleNamespace(_api=api, call_action=api.call_action)
        result = await OneBotAdapter(bot).send_video(Target('private', '42'), 'https://example/video.mp4')
        self.assertEqual(result, {'message_id': 123})
        self.assertEqual(calls[0][0], 'send_private_msg')
        self.assertEqual(calls[0][1]['timeout'], 480000)
        self.assertEqual(calls[0][2], 480)
        self.assertEqual(api._wsr_api._timeout_sec, 180)

    async def test_cache_isolated_by_platform_instance_and_account(self):
        cache = VideoDeliveryCache()
        self.addAsyncCleanup(cache.close)
        upload = AsyncMock(return_value={'message_id': 1})
        forward = AsyncMock(return_value={'message_id': 2})
        for instance, account in [('a', '9'), ('b', '9'), ('a', '10')]:
            event = SimpleNamespace(unified_msg_origin=instance + ':GroupMessage:123')
            await cache.deliver(OneBotAdapter.cache_account(event, account), 'video', upload, forward)
        self.assertEqual(upload.await_count, 3)
        forward.assert_not_awaited()

    def test_selection_default_and_instance_frozen(self):
        with patch.dict('os.environ', {}, clear=True):
            self.assertIsInstance(transport_for(), LegacyOneBotAdapter)
            owner = SimpleNamespace(transport_mode='adapter', config={'transport_mode': 'legacy'})
            self.assertIsInstance(transport_for(owner), OneBotAdapter)
            with self.assertRaises(ValueError):
                transport_for(SimpleNamespace(config={'transport_mode': 'typo'}))
        self.assertEqual(Target('group', 123).id, '123')
        self.assertEqual(delivery_receipt(None).outcome, 'unknown')
        self.assertEqual(delivery_receipt(None, native_source='7', null_native_success=True).outcome, 'success')
