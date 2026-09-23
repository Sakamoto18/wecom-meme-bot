"""Drive the real on_qq_message handler: every share must get a result reaction.

Runs inside the AstrBot container, where astrbot and aiohttp exist, so the
handler under test is the deployed code path rather than a copy of it.
"""
import asyncio
import importlib
import os
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.getenv('LONGTU_BRIDGE_TEST_PLUGIN_ROOT', '/AstrBot/data/plugins'))
main = importlib.import_module('astrbot_plugin_longtu_bridge.main')
LongtuQqBridge = main.LongtuQqBridge

GALLERY = {
    'mode': 'media-gallery',
    'messages': [{
        'type': 'forward', 'title': '小红书图文', 'description': '正文',
        'images': ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg'],
        'coverUrl': 'https://cdn.example/1.jpg', 'author': '作者',
        'avatarUrl': '', 'tags': [], 'provider': 'xiaohongshu',
    }],
}
VIDEO = {
    'mode': 'media',
    'messages': [{'type': 'video', 'url': 'https://cdn.example/v.mp4',
                  'title': '视频', 'provider': 'douyin'}],
}


def build(response, forward_fails=False, image_fails=False, video_error=None, video_result=None):
    """Real instance with only the outside world stubbed out."""
    bridge = LongtuQqBridge.__new__(LongtuQqBridge)
    bridge.config = {}
    bridge.media_status_cache = {}
    bridge.cover_cache = {}
    reactions = []
    actions = []

    async def call_action(action, **kwargs):
        actions.append(action)
        if any(s.get('type') == 'video' for s in kwargs.get('message', [])):
            if video_error:
                raise video_error
            if video_result is not None:
                return video_result
        if 'forward' in action and forward_fails:
            return {'status': 'failed', 'retcode': 1200}
        if action.endswith(('send_group_msg', 'send_private_msg')) and image_fails:
            return {'status': 'failed', 'retcode': 1200}
        return {'message_id': 1}

    async def react(event, success):
        reactions.append(success)
        return True

    async def request_backend(payload):
        return response

    async def noop(*args, **kwargs):
        return None

    async def video_card(message):
        return ''

    bridge._react_media_result = react
    bridge._request_backend = request_backend
    bridge._react_media_share = noop
    bridge._video_card = video_card
    bridge._cache_recent_images = lambda *a, **k: None
    bridge._recent_images_for_reference = lambda *a, **k: []
    bridge._is_slash_command = lambda event: False
    bridge._should_reply = lambda event: True
    bridge._is_pure_bot_mention = lambda event: False
    bridge._media_group_enabled = lambda event, text='': True
    bridge._reply_prefix = lambda event, components: []
    bridge._raw_text = lambda event: 'https://www.xiaohongshu.com/explore/abc'
    bridge._text_for_backend = lambda *a, **k: 'https://www.xiaohongshu.com/explore/abc'
    bridge._quoted_author = lambda component: ('', '')
    bridge._quoted_text = lambda chain: ''
    bridge._quoted_message_chain = noop

    async def group_info(*args, **kwargs):
        return {'group_member_count': 200, 'group_member_limit': 500}
    bridge._group_info = group_info
    bridge._observe_only = lambda *a, **k: False

    async def forwarded_content(event, components, **kwargs):
        return '', []
    bridge._forwarded_content = forwarded_content

    async def image_base64s(*args, **kwargs):
        return []
    bridge._image_base64s = image_base64s

    event = SimpleNamespace(
        bot=SimpleNamespace(call_action=call_action),
        message_obj=SimpleNamespace(message_id='555', self_id='2170902293'),
        is_private_chat=lambda: False,
        get_group_id=lambda: '499615970',
        get_sender_id=lambda: '1079175957',
        get_self_id=lambda: '2170902293',
        get_sender_name=lambda: '发送者',
        get_messages=lambda: [],
        message_str='https://www.xiaohongshu.com/explore/abc',
        call_llm=False,
        stop_event=lambda: None,
        chain_result=lambda chain: SimpleNamespace(chain=chain),
        plain_result=lambda text: SimpleNamespace(text=text),
    )
    return bridge, event, reactions, actions


async def drive(bridge, event):
    yielded = []
    async for result in bridge.on_qq_message(event):
        yielded.append(result)
    return yielded


class GalleryReactionTests(unittest.IsolatedAsyncioTestCase):
    async def test_gallery_forward_success_reacts_success(self):
        bridge, event, reactions, actions = build(GALLERY)
        await drive(bridge, event)
        self.assertIn('send_group_forward_msg', actions)
        self.assertEqual(reactions, [True], '图文转发成功必须回应成功')

    async def test_gallery_per_image_fallback_still_reacts_success(self):
        """合并转发失败但逐图发送成功，用户看到了图，算成功。"""
        bridge, event, reactions, actions = build(GALLERY, forward_fails=True)
        await drive(bridge, event)
        self.assertEqual(reactions, [True])

    async def test_gallery_total_delivery_failure_reacts_failure(self):
        """转发和逐图都被拒：判据是 OneBot 回执，不是 yield 有没有抛异常。"""
        bridge, event, reactions, actions = build(
            GALLERY, forward_fails=True, image_fails=True,
        )
        await drive(bridge, event)
        self.assertEqual(reactions, [False], '一张图都没发出去必须回应失败')

    async def test_gallery_reacts_exactly_once(self):
        for label, kwargs in (
            ('转发成功', {}),
            ('逐图兜底', {'forward_fails': True}),
            ('全部失败', {'forward_fails': True, 'image_fails': True}),
        ):
            with self.subTest(label):
                bridge, event, reactions, _ = build(GALLERY, **kwargs)
                await drive(bridge, event)
                self.assertEqual(len(reactions), 1, '同一条分享不能回应两次')

    async def test_gallery_without_images_reacts_failure(self):
        empty = {'mode': 'media-gallery', 'messages': [
            {'type': 'forward', 'title': 't', 'images': [], 'provider': 'xiaohongshu'},
        ]}
        bridge, event, reactions, actions = build(empty)
        await drive(bridge, event)
        self.assertEqual(reactions[-1], False)

    async def test_video_path_reaction_is_unchanged(self):
        bridge, event, reactions, actions = build(VIDEO)
        await drive(bridge, event)
        self.assertEqual(reactions, [True], '视频路径的回应不能被改动影响')

    async def test_simultaneous_groups_keep_card_first_and_share_one_video_upload(self):
        bridge, first, reactions, _ = build(VIDEO)
        second = SimpleNamespace(**vars(first))
        second.get_group_id = lambda: '913546080'
        second.message_obj = SimpleNamespace(message_id='556', self_id='2170902293')
        entered, finish = asyncio.Event(), asyncio.Event()
        sent = []
        async def card(message):
            return 'card-png'
        async def call_action(action, **kwargs):
            kind = kwargs.get('message', [{}])[0].get('type', 'native-forward')
            sent.append((str(kwargs['group_id']), kind))
            if kind == 'video':
                entered.set()
                await finish.wait()
                return {'message_id': 1001}
            if action == 'forward_group_single_msg':
                self.assertEqual(kwargs['message_id'], 1001)
                return None  # The actual deployed NapCat action's success data.
            return {'message_id': 1000}
        first.bot = second.bot = SimpleNamespace(call_action=call_action)
        bridge._video_card = card
        one = asyncio.create_task(drive(bridge, first))
        await asyncio.wait_for(entered.wait(), timeout=2)
        two = asyncio.create_task(drive(bridge, second))
        await asyncio.sleep(0)
        finish.set()
        await asyncio.gather(one, two)
        self.assertEqual([kind for group, kind in sent if group == '499615970'], ['image', 'video'])
        self.assertEqual([kind for group, kind in sent if group == '913546080'], ['image', 'native-forward'])
        self.assertEqual(reactions, [True, True])
        await bridge.video_delivery_cache.close()

    async def test_video_send_exception_must_not_be_swallowed_as_success(self):
        bridge, event, reactions, actions = build(VIDEO, video_error=RuntimeError('terminated'))
        yielded = await drive(bridge, event)
        self.assertEqual(reactions, [False])
        self.assertEqual(actions, ['send_group_msg', 'send_group_msg'])
        self.assertEqual(yielded, [], '发送结果由真实回执判断，不依赖 yield')

    async def test_video_timeout_sends_notice_without_resubmitting_video(self):
        bridge, event, reactions, actions = build(VIDEO, video_error=RuntimeError('WebSocket API call timeout'))
        await drive(bridge, event)
        self.assertEqual(reactions, [False])
        self.assertEqual(actions, ['send_group_msg', 'send_group_msg'])

    async def test_video_failure_receipt_must_not_count_as_success(self):
        bridge, event, reactions, actions = build(VIDEO, video_result={'status': 'failed', 'retcode': 1200})
        await drive(bridge, event)
        self.assertEqual(reactions, [False])

    async def test_actual_aiocqhttp_video_wait_does_not_change_chat_timeout(self):
        from aiocqhttp.api_impl import ResultStore, UnifiedApi, WebSocketReverseApi
        socket = SimpleNamespace(send=AsyncMock())
        transport = WebSocketReverseApi({'2170902293': socket}, set(), 180)
        api = UnifiedApi(wsr_api=transport)
        bot = SimpleNamespace(_api=api, call_action=api.call_action)
        bridge = LongtuQqBridge.__new__(LongtuQqBridge)
        with patch.object(ResultStore, 'fetch', new_callable=AsyncMock,
                          return_value={'status': 'ok', 'data': {'message_id': 123}}) as receipt:
            result = await bridge._call_video_send(bot, 'send_group_msg', {'group_id': 1109147947}, 'https://cdn/v.mp4')
        self.assertEqual(result, {'message_id': 123})
        self.assertEqual(receipt.await_args.args[1], 480)
        self.assertEqual(transport._timeout_sec, 180)
        socket.send.assert_awaited_once()

    async def test_media_unavailable_still_reacts_failure(self):
        bridge, event, reactions, actions = build({'mode': 'media-unavailable', 'messages': []})
        await drive(bridge, event)
        self.assertIn(False, reactions)

    async def test_plain_chat_gets_no_media_reaction(self):
        """普通对话不该产生媒体结果回应。"""
        chat = {'mode': 'chat', 'messages': [{'type': 'text', 'text': '你好'}]}
        bridge, event, reactions, actions = build(chat)
        bridge._raw_text = lambda e: '你好'
        bridge._text_for_backend = lambda *a, **k: '你好'
        await drive(bridge, event)
        self.assertEqual(reactions, [])


if __name__ == '__main__':
    unittest.main()
