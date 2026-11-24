"""Official group isolation and whole-media rejection; no live QQ requests."""
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import astrbot.api.message_components as Comp
from astrbot.api.event import MessageChain
from astrbot_plugin_longtu_bridge import official_trial as o
from astrbot_plugin_longtu_bridge.merchant_alert import MerchantMonitor
from test import test_official_trial as fixtures


class OfficialDeliveryPolicyTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, private=False):
        return fixtures.OfficialTrialTests().fixture(private=private)

    async def test_disabled_groups_stop_before_backend_commands_or_shares(self):
        for text in ('你好', '/远行商人', 'https://b23.tv/example', '/usage-report'):
            with self.subTest(text=text):
                bridge, event = self.fixture()
                bridge.config['official_group_enabled'] = False
                event.get_messages = lambda: [Comp.At(qq='bot'), Comp.Plain(text)]
                with patch('astrbot_plugin_longtu_bridge.merchant_command.handle_merchant_command',
                           AsyncMock()) as merchant:
                    await o.handle_official_message(bridge, event)
                bridge._request_backend.assert_not_awaited()
                event.send.assert_not_awaited()
                merchant.assert_not_awaited()
                event.stop_event.assert_called_once()
                self.assertFalse(event.call_llm)

    async def test_private_reply_still_works_and_group_can_be_reenabled(self):
        for private in (True, False):
            bridge, event = self.fixture(private=private)
            bridge.config['official_group_enabled'] = False
            if not private:
                await o.handle_official_message(bridge, event)
                bridge.config['official_group_enabled'] = True
            await o.handle_official_message(bridge, event)
            bridge._request_backend.assert_awaited_once()
            self.assertEqual(event.send.await_count, 2)

    async def test_group_switch_stops_proactive_jobs_but_retains_private_delivery(self):
        bridge, _ = self.fixture()
        bridge.config['official_group_enabled'] = False
        platform = SimpleNamespace(meta=lambda: SimpleNamespace(name='qq_official', id='test'),
                                   appid=bridge.config['official_trial_appid'],
                                   remember_session_scene=MagicMock())
        bridge.context = SimpleNamespace(platform_manager=SimpleNamespace(platform_insts=[platform]),
                                         send_message=AsyncMock(return_value=True))
        chains = [MessageChain([Comp.Plain('test')])]
        self.assertFalse(await o.proactive(bridge, 'group', chains, group=True))
        bridge.context.send_message.assert_not_awaited()
        self.assertTrue(await o.proactive(bridge, 'user', chains))
        bridge.context.send_message.assert_awaited_once()
        bridge._generate_crazy_thursday_text = AsyncMock()
        self.assertEqual(await o.mirror_crazy_thursday(bridge, '2026-11-26'), 0)
        bridge._generate_crazy_thursday_text.assert_not_awaited()
        self.assertIs(await o.mirror_learning(bridge, {
            'chatType': 'group', 'groupId': 'qqofficial:1903660238:group:group', 'text': 'test',
        }), False)
        self.assertEqual(bridge.context.send_message.await_count, 1)
        monitor = SimpleNamespace(bridge=bridge)
        self.assertEqual(await MerchantMonitor._tick_official(monitor), 'official-group-disabled')

    async def test_disabled_group_media_never_downloads_or_registers(self):
        bridge, event = self.fixture()
        bridge.config['official_group_enabled'] = False
        with patch('aiohttp.ClientSession') as session:
            await o.send_chain(bridge, event, MessageChain([Comp.Video(file='https://example/video')]))
            await o.send_official_video_url(bridge, event, 'https://example/video')
        session.assert_not_called()
        event.send.assert_not_awaited()

    async def test_prepared_large_video_sent_as_one_file_without_rewriting_source(self):
        bridge, event = self.fixture()
        bridge.config['official_video_compress_oversize_enabled'] = True
        @asynccontextmanager
        async def prepare(url, **kwargs):
            self.assertEqual(url, 'http://internal/video')
            yield SimpleNamespace(path=Path('complete.mp4'), size=190000000, original_size=250000000)
        bridge._official_video_cache = SimpleNamespace(prepare=prepare)
        video = Comp.Video(file='http://internal/video')
        await o.send_chain(bridge, event, MessageChain([video]))
        event.send.assert_awaited_once()
        chain = event.send.await_args.args[0]
        self.assertEqual(len(chain.chain), 1)
        self.assertIsInstance(chain.chain[0], Comp.File)
        self.assertEqual(chain.chain[0].name, 'video.mp4')
        self.assertEqual(video.file, 'http://internal/video')

    def session(self, response):
        session = MagicMock()
        session.__aenter__.return_value = session
        for method in ('get', 'head'):
            getattr(session, method).return_value.__aenter__.return_value = response
        return session

    async def test_oversized_content_length_rejected_before_reading_or_sending(self):
        bridge, event = self.fixture()
        response = MagicMock(status=200, headers={'Content-Length': '250000000'})
        with patch('aiohttp.ClientSession', return_value=self.session(response)):
            with self.assertRaises(o.OfficialMediaTooLarge) as raised:
                await o.send_chain(bridge, event, MessageChain([Comp.Video(file='http://internal/video')]))
        self.assertEqual(raised.exception.size, 250000000)
        self.assertIn('250.0MB', str(raised.exception))
        response.content.iter_chunked.assert_not_called()
        event.send.assert_not_awaited()

    async def test_unknown_content_length_still_enforces_total_limit(self):
        bridge, event = self.fixture()
        response = MagicMock(status=200, headers={})
        async def chunks():
            yield b'123456'
            yield b'78901'
        response.content.iter_chunked.return_value = chunks()
        with patch('aiohttp.ClientSession', return_value=self.session(response)), \
             patch.object(o, 'MAX_OFFICIAL_MEDIA_BYTES', 10):
            with self.assertRaises(o.OfficialMediaTooLarge):
                await o.send_chain(bridge, event, MessageChain([Comp.Video(file='http://internal/video')]))
        event.send.assert_not_awaited()

    async def test_readiness_rejects_413_or_oversize_without_qq_registration(self):
        for status, size in ((413, 100), (200, 200000001)):
            with self.subTest(status=status):
                bridge, event = self.fixture()
                bridge._api_url = lambda: 'http://internal/v1/qq/message'
                files = AsyncMock()
                event.bot.api = SimpleNamespace(post_group_file=files)
                response = MagicMock(status=status, headers={'Content-Length': str(size)})
                with patch('aiohttp.ClientSession', return_value=self.session(response)):
                    with self.assertRaises(o.OfficialMediaTooLarge):
                        await o.send_official_video_url(bridge, event,
                            'https://public.example/v1/qq/media/id?complete=1')
                files.assert_not_awaited()

    async def test_complete_url_uses_file_type_above_30mb_in_both_scenes(self):
        for private in (True, False):
            for size, file_type in ((30000000, 2), (30000001, 4), (200000000, 4)):
                with self.subTest(private=private, size=size):
                    bridge, event = self.fixture(private)
                    files = AsyncMock(return_value={'file_info': 'test', 'ttl': 300})
                    messages = AsyncMock(return_value={'id': 'sent'})
                    event.bot.api = SimpleNamespace(post_group_file=files, post_c2c_file=files,
                        post_group_message=messages, post_c2c_message=messages)
                    with patch.object(o, '_wait_for_official_media_ready', AsyncMock(return_value=size)):
                        await o.send_official_video_url(bridge, event,
                            'https://public.example/v1/qq/media/id?complete=1', reply_id='source')
                    self.assertEqual(files.await_args.kwargs['file_type'], file_type)
                    self.assertFalse(files.await_args.kwargs['srv_send_msg'])
                    self.assertEqual(messages.await_args.kwargs['msg_id'], 'source')
                    event.send.assert_not_awaited()

    async def test_oversize_notice_does_not_claim_uncertain_delivery(self):
        bridge, event = self.fixture()
        event.get_messages = lambda: [Comp.Plain('https://b23.tv/example')]
        bridge._video_card = AsyncMock(return_value='YWJj')
        bridge._request_backend.return_value = {'mode': 'media', 'messages': [
            {'type': 'video', 'url': 'https://example/video'}]}
        async def send(bridge, event, chain):
            if any(isinstance(c, Comp.Video) for c in chain.chain):
                raise o.OfficialMediaTooLarge(250000000)
        with patch.object(o, 'send_chain', AsyncMock(side_effect=send)):
            await o.handle_official_message(bridge, event)
        notice = event.send.await_args.args[0].chain[0].text
        self.assertIn('250.0MB', notice)
        self.assertIn('未发送', notice)
        self.assertNotIn('可能', notice)
        self.assertNotIn('\n', notice)
