"""Run in the installed AstrBot Python environment; all external I/O is fake.

LONGTU_BRIDGE_TEST_PLUGIN_ROOT must point at the isolated candidate checkout.
The production plugin/services are never loaded or restarted by these tests.
"""
import asyncio
import copy
import os
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from test import test_gallery_reaction as fixtures
from astrbot_plugin_longtu_bridge import main
from astrbot_plugin_longtu_bridge.adapter_bridge import AdapterBridge
from astrbot_plugin_longtu_bridge.adapters import DeliveryError


def create_bridge(mode):
    with patch.dict(os.environ, {'LONGTU_QQ_TRANSPORT_MODE': mode}), \
            patch.object(main.Star, '__init__', return_value=None):
        return main.LongtuQqBridge(SimpleNamespace(), {})


class RegisteredAdapter:
    def __new__(cls):
        return create_bridge('adapter')


class AdapterRegressionTests(fixtures.GalleryReactionTests):
    """Run existing complete handler scenarios via the real adapter selector."""
    def setUp(self):
        selection = patch.object(fixtures, 'LongtuQqBridge', RegisteredAdapter)
        selection.start()
        self.addCleanup(selection.stop)


class IntegrationTests(unittest.IsolatedAsyncioTestCase):
    def build(self, response, mode='adapter'):
        bridge_type = RegisteredAdapter if mode == 'adapter' else main.LongtuQqBridge
        with patch.object(fixtures, 'LongtuQqBridge', bridge_type):
            result = fixtures.build(copy.deepcopy(response))
        self.addAsyncCleanup(result[0].video_delivery_cache.close) if hasattr(result[0], 'video_delivery_cache') else None
        return result

    async def test_constructor_binds_only_opt_in_and_keeps_registered_dispatcher(self):
        for mode in ('legacy', 'adapter'):
            bridge = create_bridge(mode)
            self.addAsyncCleanup(bridge.video_delivery_cache.close)
            self.assertEqual(bridge.transport_mode, mode)
            self.assertIs(bridge.on_qq_message.__func__, main.LongtuQqBridge.on_qq_message)
            self.assertIs(bridge._send_forward_from_backend.__func__,
                          (AdapterBridge if mode == 'adapter' else main.LongtuQqBridge)._send_forward_from_backend)
            event = SimpleNamespace(message_obj=SimpleNamespace(raw_message={'message': [
                {'type': 'text', 'data': {'text': '原文'}},
                {'type': 'json', 'data': {'data': '{"url":"https://example/card"}'}}]}),
                get_messages=lambda: [])
            self.assertEqual(bridge._raw_text(event), '原文')
            self.assertEqual(bridge._rich_segments(event), main.LongtuQqBridge._rich_segments(event))
            with patch.object(AdapterBridge, 'rescue_pure_mention_before_default_llm', new_callable=AsyncMock) as rescue:
                if mode == 'adapter':
                    await bridge.rescue_pure_mention_before_default_llm(event)
                    rescue.assert_awaited_once_with(bridge, event)

    async def test_success_payload_and_onebot_arguments_match_legacy(self):
        for response in (fixtures.GALLERY, fixtures.VIDEO,
                         {'mode': 'chat', 'messages': [{'type': 'text', 'text': '你好'}]}):
            results = []
            for mode in ('legacy', 'adapter'):
                bridge, event, reactions, _ = self.build(response, mode)
                bridge._request_backend = AsyncMock(return_value=copy.deepcopy(response))
                event.bot.call_action = AsyncMock(return_value={'message_id': 42})
                event.stop_event = unittest.mock.Mock()
                yielded = await fixtures.drive(bridge, event)
                event.stop_event.assert_called_once()
                results.append((bridge._request_backend.call_args_list,
                                event.bot.call_action.call_args_list, reactions,
                                [[c.toDict() for c in result.chain] for result in yielded]))
            self.assertEqual(results[0], results[1])

    async def test_unknown_gallery_never_retries_or_falls_back(self):
        for result in (None, {}):
            bridge, event, _, _ = self.build(fixtures.GALLERY)
            event.bot.call_action = AsyncMock(return_value=result)
            with self.assertRaises(DeliveryError) as raised:
                await fixtures.drive(bridge, event)
            self.assertEqual(raised.exception.outcome, 'unknown')
            event.bot.call_action.assert_awaited_once()
        bridge, event, _, _ = self.build(fixtures.GALLERY)
        event.bot.call_action = AsyncMock(side_effect=asyncio.TimeoutError())
        with self.assertRaises(DeliveryError):
            await fixtures.drive(bridge, event)
        event.bot.call_action.assert_awaited_once()

    async def test_outer_bundle_deadline_does_not_fall_back(self):
        response = copy.deepcopy(fixtures.VIDEO)
        response['messages'] *= 2
        bridge, event, _, _ = self.build(response)
        started = []
        async def blocked(action, **kwargs):
            started.append(action)
            await asyncio.Event().wait()
        event.bot.call_action = blocked
        with patch('astrbot_plugin_longtu_bridge.adapter_bridge.VIDEO_SEND_TIMEOUT_SECONDS', 0.01):
            with self.assertRaises(DeliveryError) as raised:
                await fixtures.drive(bridge, event)
        self.assertEqual(raised.exception.outcome, 'unknown')
        self.assertEqual(started, ['send_group_forward_msg'])


if __name__ == '__main__':
    unittest.main()
