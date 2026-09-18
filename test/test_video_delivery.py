"""Exercise the bridge's real video sender with success/failure OneBot receipts."""
import ast
import asyncio
import contextlib
import logging
from pathlib import Path
import re
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

source = ast.parse((Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/main.py').read_text())
bridge = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
methods = [n for n in bridge.body if getattr(n, 'name', '') in (
    '_call_video_send', '_send_video_from_backend',
)]
namespace = dict(asyncio=asyncio, contextlib=contextlib, re=re, time=time,
                 AstrMessageEvent=object, VIDEO_SEND_TIMEOUT_SECONDS=480,
                 logger=logging.getLogger('video-test'))
exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(
    name='Bridge', bases=[], keywords=[], body=methods, decorator_list=[],
)], type_ignores=[])), '<bridge-video>', 'exec'), namespace)
Bridge = namespace['Bridge']


class VideoDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def setup_sender(self, result=None, error=None, private=False, reaction_error=False):
        actions, reactions = [], []
        async def call_action(action, **params):
            actions.append((action, params))
            if params['message'][0]['type'] == 'video':
                if error:
                    raise error
                return result
            return {'message_id': 456}
        async def react(event, success):
            reactions.append(success)
            if reaction_error:
                raise RuntimeError('reaction unavailable')
        instance = Bridge()
        instance._react_media_result = react
        event = SimpleNamespace(
            bot=SimpleNamespace(call_action=call_action),
            is_private_chat=lambda: private, get_sender_id=lambda: '42',
            get_group_id=lambda: '1109147947', message_obj=SimpleNamespace(message_id='9001'),
        )
        return instance, event, actions, reactions

    async def test_success_requires_receipt_and_sends_only_video(self):
        instance, event, actions, reactions = self.setup_sender({'message_id': 123})
        self.assertTrue(await instance._send_video_from_backend(event, {'url': 'https://cdn/v.mp4'}))
        self.assertEqual(reactions, [True])
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0], ('send_group_msg', {
            'group_id': 1109147947, 'timeout': 480000,
            'message': [{'type': 'video', 'data': {'file': 'https://cdn/v.mp4'}}],
        }))

    async def test_private_success_accepts_wrapped_receipt(self):
        instance, event, actions, reactions = self.setup_sender(
            {'status': 'ok', 'retcode': 0, 'data': {'message_id': 123}}, private=True)
        self.assertTrue(await instance._send_video_from_backend(event, {'url': 'https://cdn/v.mp4'}))
        self.assertEqual(actions[0][0], 'send_private_msg')
        self.assertEqual(actions[0][1]['user_id'], 42)
        self.assertEqual(reactions, [True])

    async def test_terminated_failure_gets_failure_reaction_and_notice(self):
        instance, event, actions, reactions = self.setup_sender(error=RuntimeError('terminated'))
        self.assertFalse(await instance._send_video_from_backend(event, {'url': 'https://cdn/v.mp4'}))
        self.assertEqual(reactions, [False])
        self.assertEqual(len(actions), 2)
        self.assertEqual(actions[1][1]['message'][0], {'type': 'reply', 'data': {'id': '9001'}})
        self.assertIn('视频发送失败', actions[1][1]['message'][1]['data']['text'])

    async def test_timeout_never_claims_success_or_retries_upload(self):
        for error in (RuntimeError('WebSocket API call timeout'), asyncio.TimeoutError()):
            instance, event, actions, reactions = self.setup_sender(error=error)
            self.assertFalse(await instance._send_video_from_backend(event, {'url': 'https://cdn/v.mp4'}))
            self.assertEqual(reactions, [False])
            self.assertEqual(len(actions), 2)
            notice = actions[1][1]['message'][1]['data']['text']
            self.assertIn('发送等待超时', notice)
            self.assertIn('可能仍在发送', notice)
            self.assertNotIn('已中断', notice)

    async def test_negative_or_missing_receipts_never_count_as_success(self):
        for result in (None, {}, {'status': 'failed', 'retcode': 1200, 'message': 'rejected'},
                       {'retcode': 1200, 'data': {'message_id': 123}}):
            instance, event, actions, reactions = self.setup_sender(result)
            self.assertFalse(await instance._send_video_from_backend(event, {'url': 'https://cdn/v.mp4'}))
            self.assertEqual(reactions, [False])
            self.assertEqual(len(actions), 2)

    async def test_reaction_failure_does_not_change_delivery_result_or_hide_notice(self):
        instance, event, actions, reactions = self.setup_sender({'message_id': 123}, reaction_error=True)
        self.assertTrue(await instance._send_video_from_backend(event, {'url': 'https://cdn/v.mp4'}))
        self.assertEqual(len(actions), 1)
        instance, event, actions, reactions = self.setup_sender(error=RuntimeError('terminated'), reaction_error=True)
        self.assertFalse(await instance._send_video_from_backend(event, {'url': 'https://cdn/v.mp4'}))
        self.assertEqual(len(actions), 2)

    async def test_video_timeout_is_per_call_and_keeps_shared_connections(self):
        seen = []
        class Transport:
            _timeout_sec = 180
            connections = object()
            async def call_action(self, action, **params):
                seen.append((self._timeout_sec, self.connections))
                return {'message_id': 1}
        class Api:
            _wsr_api = Transport()
            _http_api = Transport()
            async def call_action(self, action, **params):
                return await self._wsr_api.call_action(action, **params)
        api = Api()
        bot = SimpleNamespace(_api=api, call_action=api.call_action)
        await Bridge()._call_video_send(bot, 'send_group_msg', {'group_id': 1}, 'https://cdn/v.mp4')
        self.assertEqual(seen, [(480, api._wsr_api.connections)])
        self.assertEqual(api._wsr_api._timeout_sec, 180)
        self.assertEqual(api._http_api._timeout_sec, 180)

    async def test_hung_call_has_bounded_wait(self):
        async def hung(*args, **kwargs):
            await asyncio.Event().wait()
        bot = SimpleNamespace(call_action=hung)
        with patch.dict(namespace, VIDEO_SEND_TIMEOUT_SECONDS=0.01):
            with self.assertRaises(asyncio.TimeoutError):
                await Bridge()._call_video_send(bot, 'send_group_msg', {'group_id': 1}, 'https://cdn/v.mp4')


if __name__ == '__main__':
    unittest.main()
