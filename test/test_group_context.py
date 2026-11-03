import asyncio
import ast
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
import logging
from unittest.mock import AsyncMock, patch

path = Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/group_context.py'
spec = importlib.util.spec_from_file_location('group_context', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def row(mid, user='100', text='讨论内容', timestamp=995, group='123', images=0):
    return dict(message_id=mid, group_id=group, user_id=user, time=timestamp,
                sender=dict(nickname='群友甲'), message=[
                    dict(type='text', data=dict(text=text)),
                    *[dict(type='image', data=dict(file=f'image-{index}')) for index in range(images)],
                ])


class GroupContextTests(unittest.IsolatedAsyncioTestCase):
    def test_history_excludes_other_groups_bots_old_future_and_current_messages(self):
        rows = [row('old', timestamp=100), row('foreign', group='999'),
                row('bot-message', user='bot'), row('ok1'), row('ok2', user='200'),
                row('current', timestamp=1000), row('later', timestamp=1000),
                row('future', timestamp=1001)]
        selected = module.select_recent_messages({'data': {'messages': rows}},
            group_id='123', bot_id='bot', message_id='current', now=1000)
        self.assertEqual([item['message_id'] for item in selected], ['ok1', 'ok2'])

    def test_history_has_bounded_text_and_preserves_latest_messages(self):
        selected = module.select_recent_messages({'messages': [row(str(i), text='a' * 2000) for i in range(90)]},
            group_id='123', bot_id='bot', message_id='current', now=1000)
        self.assertLessEqual(sum(len(item['text']) for item in selected), 6000)
        self.assertLessEqual(len(selected), 30)
        self.assertEqual(selected[-1]['message_id'], '89')

    async def fetch(self, rows, **kwargs):
        action = AsyncMock(return_value={'messages': rows})
        event = SimpleNamespace(bot=SimpleNamespace(call_action=action),
            get_group_id=lambda: '123', get_self_id=lambda: 'bot',
            message_obj=SimpleNamespace(message_id='current'))
        loader = kwargs.pop('loader', AsyncMock(return_value='aW1hZ2U='))
        with patch.object(module.time, 'time', return_value=1000):
            result = await module.fetch_recent_group_context(event, loader, **kwargs)
        action.assert_awaited_once_with('get_group_msg_history', group_id=123,
                                       message_seq='current', count=30, reverseOrder=False)
        return result, loader

    async def test_pure_at_can_read_previous_members_image_without_quotation(self):
        context, loader = await self.fetch([row('picture', images=3), row('discussion', user='200')], pure_mention=True)
        self.assertEqual(len(context['messages']), 2)
        self.assertEqual(len(context['images']), 2)
        self.assertEqual(context['images'][0]['message_id'], 'picture')
        self.assertEqual(loader.await_count, 2)

    async def test_implicit_question_reads_recent_image_but_new_topic_does_not(self):
        for text, expected in [('你怎么看', 1), ('解释一下', 1), ('明天天气如何', 0), ('烧鸡', 0)]:
            with self.subTest(text=text):
                context, loader = await self.fetch([row('picture', images=1)], text=text)
                self.assertEqual(len(context['images']), expected)
                self.assertEqual(loader.await_count, expected)

    async def test_old_distant_images_and_current_attachments_are_not_reused(self):
        for rows, options in [
            ([row('old-image', images=1, timestamp=800)], {}),
            ([row('far-image', images=1)] + [row(str(i)) for i in range(6)], {}),
            ([row('image', images=1)], {'include_images': False}),
        ]:
            context, loader = await self.fetch(rows, pure_mention=True, **options)
            self.assertEqual(context['images'], [])
            loader.assert_not_awaited()

    async def test_image_failure_keeps_text_context(self):
        context, _ = await self.fetch([row('picture', images=1)], pure_mention=True,
                                     loader=AsyncMock(side_effect=asyncio.TimeoutError))
        self.assertEqual(len(context['messages']), 1)
        self.assertEqual(context['images'], [])

    async def test_bridge_skips_private_quoted_passive_and_non_mentions_and_degrades_on_error(self):
        tree = ast.parse((path.parent / 'main.py').read_text(encoding='utf-8'))
        bridge = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'LongtuQqBridge')
        method = next(node for node in bridge.body if getattr(node, 'name', '') == '_recent_group_context')
        fetch = AsyncMock(return_value={'messages': [{'text': '讨论'}], 'images': []})
        namespace = dict(AstrMessageEvent=object, fetch_recent_group_context=fetch, logger=logging.getLogger('test'))
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), '<bridge-context>', 'exec'), namespace)
        owner = SimpleNamespace(_reply_component=lambda _: None, _is_explicitly_at_bot=lambda _: True,
                                _forward_image_base64=AsyncMock(), _raw_text=lambda _: '')
        event = SimpleNamespace(is_private_chat=lambda: False, get_messages=lambda: [], get_group_id=lambda: '123')
        call = namespace['_recent_group_context']
        self.assertEqual(len((await call(owner, event, {'pure_bot_mention': True}))['messages']), 1)
        fetch.reset_mock()
        await call(owner, event, {'observe_only': True})
        await call(owner, event, {'media_share': True})
        event.is_private_chat = lambda: True
        await call(owner, event, {})
        event.is_private_chat = lambda: False
        owner._reply_component = lambda _: object()
        await call(owner, event, {})
        owner._reply_component = lambda _: None
        owner._is_explicitly_at_bot = lambda _: False
        await call(owner, event, {})
        fetch.assert_not_awaited()
        owner._is_explicitly_at_bot = lambda _: True
        fetch.side_effect = asyncio.TimeoutError
        self.assertEqual(await call(owner, event, {}), {})
