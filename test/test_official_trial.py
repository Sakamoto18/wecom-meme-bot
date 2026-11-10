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

    async def test_only_sticker_images_use_compact_route_and_preparation_failure_falls_back(self):
        for subtype, prepared in ((1,True),(1,False),(None,True)):
            bridge,event=self.fixture()
            bridge._request_backend.return_value={'messages':[{'type':'image','base64':'YWJj','sub_type':subtype}]}
            with patch('astrbot_plugin_longtu_bridge.official_compact_image.send_compact_image',
                       new_callable=AsyncMock,return_value=prepared) as compact:
                await handle_official_message(bridge,event)
            self.assertEqual(compact.await_count,1 if subtype==1 else 0)
            self.assertEqual(event.send.await_count,0 if subtype==1 and prepared else 1)

    async def test_disable_wrong_app_and_disallowed_groups_are_silent(self):
        for mode in ('disabled', 'wrong-app', 'disallowed-group'):
            bridge, event = self.fixture(private=False)
            if mode == 'disabled': bridge.config['official_trial_enabled'] = False
            if mode == 'wrong-app': bridge.config['official_trial_appid'] = 'other'
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

    async def test_full_group_share_accepts_empty_allowlist_but_filters_chat_and_bots(self):
        for kind in ('link', 'card', 'bot', 'no-allowlist', 'web-link'):
            bridge, event = self.fixture(private=False)
            bridge.config['official_trial_groups'] = 'group-openid'
            event.get_messages = lambda: [Comp.Plain('https://b23.tv/example')]
            if kind == 'card':
                event.get_messages = lambda: [Comp.Plain('[卡片消息]')]
                event.message_obj.raw_message.raw_data = {'ark_data':{'fields':{'jump_url':'https://v.douyin.com/example/'}}}
            if kind == 'web-link': event.get_messages = lambda: [Comp.Plain('https://example.com/article')]
            if kind == 'bot': event.message_obj.raw_message.author.bot = True
            if kind == 'no-allowlist': bridge.config['official_trial_groups'] = ''
            await handle_official_message(bridge, event)
            if kind in ('link', 'card', 'no-allowlist', 'web-link'):
                payload = bridge._request_backend.call_args.args[0]
                self.assertTrue(payload['media_share'])
                self.assertFalse(payload['observe_only'])
                self.assertEqual(payload['mentions'], [])
            else:
                bridge._request_backend.assert_not_awaited()

    async def test_unmentioned_chatter_uses_passive_decider_and_silent_failures(self):
        for result in ('observe', 'reply', 'error'):
            bridge, event = self.fixture(private=False)
            event.get_messages = lambda: [Comp.Plain('今天大家聊什么')]
            bridge._request_backend.return_value = {'messages': [] if result == 'observe' else [
                {'type': 'text', 'text': '接话'}], 'active_reply': result == 'reply'}
            if result == 'error': bridge._request_backend.side_effect = RuntimeError('backend failed')
            await handle_official_message(bridge, event)
            self.assertTrue(bridge._request_backend.call_args.args[0]['observe_only'])
            self.assertEqual(event.send.await_count, 1 if result == 'reply' else 0)

    async def test_bot_messages_are_filtered_even_when_mentioning_us(self):
        bridge, event = self.fixture(private=False)
        event.message_obj.raw_message.author.bot = True
        await handle_official_message(bridge, event)
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

    async def test_media_receipts_are_silent_on_success_and_explicit_on_failure(self):
        for mode in ('success', 'unavailable', 'timeout', 'send-failed'):
            bridge, event = self.fixture()
            event.get_messages = lambda: [Comp.Plain('https://b23.tv/example')]
            bridge._video_card = AsyncMock(return_value='YWJj')
            bridge._request_backend.return_value = {'mode':'media','messages':[{'type':'video','url':'https://example/video'}]}
            if mode == 'unavailable': bridge._request_backend.return_value = {'mode':'media-unavailable','messages':[]}
            if mode == 'timeout': bridge._request_backend.side_effect = asyncio.TimeoutError()
            with patch('astrbot_plugin_longtu_bridge.official_trial.send_chain', new_callable=AsyncMock) as send:
                if mode == 'send-failed': send.side_effect = RuntimeError('upload rejected')
                await handle_official_message(bridge, event)
            texts = [call.args[0].chain[0].text for call in event.send.call_args_list]
            if mode == 'success':
                self.assertEqual(texts, [])
                self.assertEqual(send.await_count, 2)
                continue
            expected = {'unavailable':'抓取失败',
                        'timeout':'抓取等待超时','send-failed':'未全部确认发送'}[mode]
            self.assertIn(expected, texts[-1])
            self.assertLessEqual(event.send.await_count + send.await_count, 4)

    async def test_gallery_is_one_message_with_all_images_and_intro(self):
        for private in (True, False):
            for outcome in ('success', 'empty', 'timeout'):
                with self.subTest(private=private, outcome=outcome):
                    bridge, event = self.fixture(private=private)
                    event.get_messages = lambda: [Comp.Plain('https://v.douyin.com/example')]
                    gallery = {'type': 'forward', 'provider': 'douyin',
                               'title': '图文标题', 'description': '图文说明',
                               'images': [f'https://example/{i}' for i in range(18)]}
                    bridge._request_backend.return_value = {'mode': 'media-gallery', 'messages': [gallery]}
                    bridge._video_card = AsyncMock(return_value='YWJj' if outcome == 'success' else '')
                    if outcome == 'timeout':
                        bridge._video_card.side_effect = asyncio.TimeoutError()
                    with patch('astrbot_plugin_longtu_bridge.official_gallery.send_gallery',
                               new_callable=AsyncMock) as send:
                        await handle_official_message(bridge, event)
                    bridge._video_card.assert_awaited_once_with(gallery)
                    send.assert_awaited_once_with(event, bridge, [gallery], 'YWJj' if outcome == 'success' else '')
                    event.send.assert_not_awaited()

    async def test_gallery_failure_never_falls_back_to_separate_images(self):
        from astrbot_plugin_longtu_bridge.official_gallery import GalleryPreparationError
        for error in (GalleryPreparationError('图集准备失败'), asyncio.TimeoutError(), RuntimeError('rejected')):
            bridge, event = self.fixture(private=False)
            event.get_messages = lambda: [Comp.Plain('https://v.douyin.com/example')]
            bridge._video_card = AsyncMock(return_value='YWJj')
            bridge._request_backend.return_value = {'mode':'media-gallery', 'messages':[
                {'type':'forward','images':['https://example/image'] * 10}]}
            with patch('astrbot_plugin_longtu_bridge.official_gallery.send_gallery',
                       new_callable=AsyncMock, side_effect=error) as send:
                await handle_official_message(bridge,event)
            send.assert_awaited_once()
            event.send.assert_awaited_once()
            self.assertIsInstance(event.send.call_args.args[0].chain[0], Comp.Plain)

    def test_media_budget_and_opaque_identity_length(self):
        chains = output_chains({'messages': [{'type': 'forward', 'images': ['https://example/image'] * 18}]})
        self.assertEqual(len(chains), 5)
        self.assertIn('前几张', chains[0].chain[0].text)
        self.assertLessEqual(len(identity('1903660238', 'message', 'x' * 400)), 128)

    async def test_text_bubbles_split_and_only_overflow_is_merged(self):
        for private, limit in ((True, 4), (False, 5)):
            for count in (3, 7):
                bridge, event = self.fixture(private=private)
                texts = [f'第{i}句' for i in range(count)]
                bridge._request_backend.return_value = {'messages':[
                    {'type':'text', 'text':text} for text in texts]}
                await handle_official_message(bridge, event)
                sent = [call.args[0].chain[0].text for call in event.send.call_args_list]
                expected = texts if count <= limit else texts[:limit - 1] + ['\n'.join(texts[limit - 1:])]
                self.assertEqual(sent, expected)

    def test_split_text_reserves_media_slots_and_video_stays_two_messages(self):
        media = [{'type':'image','base64':'YWJj'}, {'type':'video','url':'https://example/video'}]
        chains = output_chains({'messages': media}, max_messages=3)
        self.assertEqual([type(c.chain[0]) for c in chains], [Comp.Image, Comp.Video])
        chains = output_chains({'messages':[
            {'type':'text','text':str(i)} for i in range(4)] + media}, max_messages=5)
        self.assertEqual([c.chain[0].text for c in chains[:3]], ['0','1','2\n3'])
        self.assertEqual([type(c.chain[0]) for c in chains[3:]], [Comp.Image, Comp.Video])

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
