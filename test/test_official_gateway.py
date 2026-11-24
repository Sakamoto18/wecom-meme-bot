import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

from astrbot_plugin_longtu_bridge.official_gateway import GatewayCards, install_gateway_capture
from astrbot_plugin_longtu_bridge.official_media import extract_official_media


def frame(group='test-group', msg_id='test-message'):
    return {'op': 0, 't': 'GROUP_MESSAGE_CREATE', 's': 123,
            'd': {'id': msg_id, 'group_openid': group, 'message_type': 3,
                  'ark_data': {'fields': {'source': '哔哩哔哩', 'jump_url': 'https://b23.tv/test'}},
                  'message_scene': {'ext': ['auth_token=keep-in-private-capture']}}}


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def test_hook_captures_before_conversion_and_is_idempotent(self):
        original = AsyncMock(return_value='delivered')
        class Socket:
            async def on_message(self, ws, message):
                return await original(self, ws, message)
        socket = Socket()
        socket._client = SimpleNamespace(platform=SimpleNamespace(appid='one'))
        with TemporaryDirectory() as directory:
            store = install_gateway_capture('one', directory, websocket_class=Socket)
            wrapped = Socket.on_message
            other = install_gateway_capture('two', directory, websocket_class=Socket)
            self.assertIs(Socket.on_message, wrapped)
            packet = frame()
            original.side_effect = lambda *_: self.assertIsNotNone(store.lookup('test-group', 'test-message'))
            await socket.on_message(None, json.dumps(packet))
            original.assert_awaited_once()
            self.assertEqual(store.lookup('test-group', 'test-message'), packet)
            self.assertIsNone(other.lookup('test-group', 'test-message'))

    def test_gateway_body_overrides_truncated_adapter_body(self):
        raw = SimpleNamespace(raw_data={'ark_data': {'fields': {'source': '哔哩哔哩'}}}, content='')
        self.assertEqual(extract_official_media(raw)['video_urls'], [])
        self.assertEqual(extract_official_media(raw, gateway_packet=frame())['video_urls'], ['https://b23.tv/test'])

    def test_jumpurl_spelling_nested_json_and_escaped_values(self):
        for key in ['jumpUrl', 'jump_url', 'qqdocurl']:
            packet = frame()
            packet['d']['ark_data'] = json.dumps({'meta': {'detail_1': {key: 'https:\\/\\/b23.tv/test'}}})
            self.assertEqual(extract_official_media(SimpleNamespace(), packet)['video_urls'], ['https://b23.tv/test'])

    def test_capture_exact_frame_only_when_armed_and_matching(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            store = GatewayCards(directory)
            encoded = json.dumps(frame(), ensure_ascii=False, indent=2)
            store.record(encoded, now=100)
            self.assertEqual(list(root.glob('*.json')), [])
            (root/'arm.json').write_text(json.dumps({'expires_at': 200, 'group_openid': 'test-group',
                                                   'capture_id': 'test', 'max_events': 1}))
            store.record(json.dumps(frame(group='other')), now=101)
            self.assertEqual(len(list(root.glob('*.json'))), 1)
            store.record(encoded, now=102)
            captures = list(root.glob('*-*.json'))
            self.assertEqual(len(captures), 1)
            self.assertEqual(captures[0].read_bytes(), encoded.encode())
            store.record(json.dumps(frame(msg_id='second')), now=103)
            self.assertEqual(len(list(root.glob('*-*.json'))), 1)

    def test_expired_arm_does_not_save(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'arm.json').write_text(json.dumps({'expires_at': 99, 'group_openid': 'test-group'}))
            GatewayCards(directory).record(json.dumps(frame()), now=100)
            self.assertEqual(len(list(root.glob('*.json'))), 1)

    def test_cache_is_bounded_expiring_and_returns_independent_data(self):
        with TemporaryDirectory() as directory:
            store = GatewayCards(directory)
            for i in range(70):
                store.record(json.dumps(frame(msg_id=str(i))), now=100)
            self.assertEqual(len(store.events), 64)
            self.assertIsNone(store.lookup('test-group', '0', now=100))
            copy = store.lookup('test-group', '69', now=100)
            copy['d']['ark_data'] = None
            self.assertIsNotNone(store.lookup('test-group', '69', now=100)['d']['ark_data'])
            self.assertIsNone(store.lookup('test-group', '69', now=701))
            self.assertEqual(store.bytes, 0)

    def test_system_events_malformed_or_large_input_not_cached(self):
        with TemporaryDirectory() as directory:
            store = GatewayCards(directory)
            for data in ['not-json', '[]', 'x' * (1024*1024+1), json.dumps({'op': 2, 'd': {'token': 'secret'}})]:
                store.record(data)
            self.assertEqual(len(store.events), 0)

    async def test_capture_failure_never_blocks_normal_dispatch(self):
        class Socket:
            async def on_message(self, ws, message):
                return 'delivered'
        socket = Socket()
        socket._client = SimpleNamespace(platform=SimpleNamespace(appid='one'))
        store = install_gateway_capture('one', 'unused', websocket_class=Socket)
        store.record = Mock(side_effect=RuntimeError('disk failure'))
        self.assertEqual(await socket.on_message(None, json.dumps(frame())), 'delivered')
