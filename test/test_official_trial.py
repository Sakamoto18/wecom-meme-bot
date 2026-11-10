"""Official QQ bridge tests in the real AstrBot environment; no live sends."""
import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import astrbot.api.message_components as Comp
from astrbot_plugin_longtu_bridge.official_trial import handle_official_message, identity, output_chains, media_segments, mirror_learning, official_group_names
from astrbot_plugin_longtu_bridge.main import LongtuQqBridge


class OfficialTrialTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, private=True):
        bridge = SimpleNamespace(
            config={'official_trial_enabled': True, 'official_trial_appid': '1903660238'},
            _image_base64s=AsyncMock(return_value=[]),
            _request_backend=AsyncMock(return_value={'messages': [
                {'type': 'text', 'text': '文字回复'}, {'type': 'image', 'base64': 'YWJj'}]}),
        )
        raw = SimpleNamespace(group_openid=None if private else 'group-openid',
                              author=SimpleNamespace(user_openid='user-openid'))
        event = SimpleNamespace(
            bot=SimpleNamespace(platform=SimpleNamespace(appid='1903660238')),
            message_obj=SimpleNamespace(message_id='message1', raw_message=raw),
            get_platform_name=lambda: 'qq_official', get_self_id=lambda: 'bot',
            get_sender_id=lambda: 'user-openid', get_sender_name=lambda: '试用者',
            get_group_id=lambda: '' if private else 'group-openid',
            is_private_chat=lambda: private,
            get_messages=lambda: [Comp.Plain('来张鹿图'), Comp.At(qq='bot')],
            send=AsyncMock(), stop_event=Mock(),
        )
        return bridge, event

    async def test_registered_dispatch_sends_text_image_and_isolates_openids(self):
        bridge, event = self.fixture()
        await LongtuQqBridge.on_official_qq_message(bridge, event)
        payload = bridge._request_backend.call_args.args[0]
        self.assertEqual(payload['user_id'], 'qqofficial:1903660238:user:user-openid')
        self.assertEqual(payload['group_id'], '')
        self.assertEqual(event.send.await_count, 2)
        self.assertIs(type(event.send.call_args.args[0].chain[0]), Comp.Image)
        self.assertFalse(event.send.call_args.args[0].use_markdown_)
        event.stop_event.assert_called_once()

    async def test_onebot_never_intercepted(self):
        bridge, event = self.fixture()
        event.get_platform_name = lambda: 'aiocqhttp'
        await LongtuQqBridge.on_official_qq_message(bridge, event)
        bridge._request_backend.assert_not_awaited()
        event.stop_event.assert_not_called()

    async def test_disable_wrong_app_and_unmentioned_groups_are_silent(self):
        for mode in ('disabled', 'wrong-app', 'ordinary', 'disallowed-group'):
            bridge, event = self.fixture(private=False)
            if mode == 'disabled': bridge.config['official_trial_enabled'] = False
            if mode == 'wrong-app': bridge.config['official_trial_appid'] = 'other'
            if mode == 'ordinary': event.get_messages = lambda: [Comp.Plain('普通消息')]
            if mode == 'disallowed-group': bridge.config['official_trial_groups'] = 'another'
            await handle_official_message(bridge, event)
            event.send.assert_not_awaited()
            bridge._request_backend.assert_not_awaited()
            event.stop_event.assert_called_once()

    async def test_unknown_send_not_retried_on_replayed_event(self):
        bridge, event = self.fixture()
        event.send.side_effect = asyncio.TimeoutError()
        await handle_official_message(bridge, event)
        await handle_official_message(bridge, event)
        event.send.assert_awaited_once()
        bridge._request_backend.assert_awaited_once()

    async def test_full_group_event_accepts_direct_share_only_in_verified_trial_group(self):
        for kind in ('link', 'card', 'ordinary', 'bot', 'no-allowlist'):
            bridge, event = self.fixture(private=False)
            bridge.config['official_trial_groups'] = 'group-openid'
            event.get_messages = lambda: [Comp.Plain('https://b23.tv/example')]
            if kind == 'card':
                event.get_messages = lambda: [Comp.Plain('[卡片消息]')]
                event.message_obj.raw_message.raw_data = {'ark_data':{'fields':{'jump_url':'https://v.douyin.com/example/'}}}
            if kind == 'ordinary': event.get_messages = lambda: [Comp.Plain('普通消息')]
            if kind == 'bot': event.message_obj.raw_message.author.bot = True
            if kind == 'no-allowlist': bridge.config['official_trial_groups'] = ''
            await handle_official_message(bridge, event)
            if kind in ('link', 'card'):
                payload = bridge._request_backend.call_args.args[0]
                self.assertTrue(payload['media_share'])
                self.assertFalse(payload['observe_only'])
                self.assertEqual(payload['mentions'], [])
            else:
                bridge._request_backend.assert_not_awaited()

    async def test_current_and_quote_images_forwarded_without_onebot(self):
        bridge, event = self.fixture(private=False)
        event.get_messages = lambda: [Comp.At(qq='bot'), Comp.Image(file='https://example/image'),
            Comp.Reply(id='ref', chain=[Comp.Plain('引用内容'), Comp.Image(file='https://example/quote')])]
        bridge._image_base64s.side_effect = [['YWJj'], ['ZGVm']]
        await handle_official_message(bridge, event)
        payload = bridge._request_backend.call_args.args[0]
        self.assertEqual(payload['image_base64s'], ['YWJj'])
        self.assertEqual(payload['quoted_image_base64s'], ['ZGVm'])
        self.assertEqual(payload['quoted_text'], '引用内容')
        self.assertFalse(payload['pure_bot_mention'])

    def test_media_budget_and_opaque_identity_length(self):
        chains = output_chains({'messages': [{'type': 'forward', 'images': ['https://example/image'] * 18}]})
        self.assertEqual(len(chains), 5)
        self.assertIn('前几张', chains[0].chain[0].text)
        self.assertLessEqual(len(identity('1903660238', 'message', 'x' * 400)), 128)

    async def test_verified_identity_restores_admin_commands_and_raw_slash(self):
        bridge, event = self.fixture()
        bridge.config['official_trial_user_bindings'] = '{"user-openid":"1079175957"}'
        event.message_obj.raw_message.content = '/指令'
        event.get_messages = lambda: [Comp.Plain('指令')]
        await handle_official_message(bridge, event)
        payload = bridge._request_backend.call_args.args[0]
        self.assertEqual(payload['user_id'], '1079175957')
        self.assertEqual(payload['text'], '/指令')

    async def test_report_uses_original_renderer_and_replies_in_official_chat(self):
        bridge, event = self.fixture()
        bridge.config['official_trial_user_bindings'] = {'user-openid': '1079175957'}
        event.message_obj.raw_message.content = '/usage-report'
        with patch('astrbot_plugin_longtu_bridge.official_trial.report_chains', new_callable=AsyncMock,
                   return_value=output_chains({'messages':[{'type':'image','base64':'YWJj'}]})) as report:
            await handle_official_message(bridge, event)
        self.assertEqual(report.call_args.kwargs['requested_by'], '1079175957')
        event.send.assert_awaited_once()
        bridge._request_backend.assert_not_awaited()

    async def test_group_report_is_private_and_failed_delivery_is_not_claimed_sent(self):
        for delivered in (True, False):
            bridge, event = self.fixture(private=False)
            bridge.config['official_trial_user_bindings'] = {'user-openid': '1079175957'}
            event.message_obj.raw_message.content = '/usage-report'
            chains = output_chains({'messages':[{'type':'image','base64':'YWJj'}]})
            with patch('astrbot_plugin_longtu_bridge.official_trial.report_chains',
                       new_callable=AsyncMock, return_value=chains), patch(
                       'astrbot_plugin_longtu_bridge.official_trial.proactive',
                       new_callable=AsyncMock, return_value=delivered) as send:
                await handle_official_message(bridge, event)
            send.assert_awaited_once_with(bridge, 'user-openid', chains)
            event.send.assert_awaited_once()
            reply = event.send.call_args.args[0].chain
            self.assertTrue(all(isinstance(c, Comp.Plain) for c in reply))
            self.assertIn('已发送' if delivered else '投递失败', reply[0].text)

    async def test_official_card_reaches_media_backend_and_video_output_is_not_dropped(self):
        bridge, event = self.fixture()
        event.message_obj.raw_message.raw_data = {'msg_elements':[{'ark_data':
            '{"meta":{"news":{"jumpUrl":"https://b23.tv/test"}}}'}]}
        await handle_official_message(bridge, event)
        payload = bridge._request_backend.call_args.args[0]
        self.assertTrue(payload['media_share'])
        self.assertEqual(payload['rich_segments'][0]['data']['url'], 'https://b23.tv/test')
        chains=output_chains({'messages':[{'type':'video','url':'http://127.0.0.1:8787/media/test'}]})
        self.assertIsInstance(chains[0].chain[0], Comp.Video)

    async def test_learning_mirror_preserves_legacy_receipt_and_routes_official_ids(self):
        bridge, event = self.fixture()
        bridge.config.update(official_trial_user_bindings={'user-openid':'1079175957'},official_trial_push_enabled=True)
        with patch('astrbot_plugin_longtu_bridge.official_trial.proactive', new_callable=AsyncMock,return_value=True) as send:
            self.assertIsNone(await mirror_learning(bridge,{'chatType':'private','userId':'1079175957','text':'日报'}))
            self.assertEqual(send.call_args.args[1], 'user-openid')
            self.assertTrue(await mirror_learning(bridge,{'chatType':'group','groupId':'qqofficial:1903660238:group:group-id','text':'学完了'}))
            self.assertEqual(send.call_args.args[1], 'group-id')
            self.assertTrue(send.call_args.kwargs['group'])

    async def test_verified_group_mapping_uses_live_qq_name_and_safe_fallback(self):
        bridge, _ = self.fixture()
        bridge.config['official_trial_group_bindings'] = {'openid': {'qq_group_id': '1109147947'}}
        bridge._group_names = AsyncMock(return_value={'1109147947':'测试群真实名称'})
        key = 'qqofficial:1903660238:group:openid'
        self.assertEqual(await official_group_names(bridge, [key]), {key:'测试群真实名称'})
        bridge._group_names.assert_awaited_once_with(['1109147947'])
        bridge._group_names.return_value = {}
        self.assertEqual(await official_group_names(bridge, [key]), {key:'QQ群 1109147947'})


if __name__ == '__main__':
    unittest.main()
