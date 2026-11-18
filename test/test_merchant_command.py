"""Run with real AstrBot components and fake network/durable temporary state."""
import asyncio
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import astrbot.api.message_components as Comp
from astrbot_plugin_longtu_bridge import merchant_command as c
from astrbot_plugin_longtu_bridge import merchant_official as o
from astrbot_plugin_longtu_bridge.main import LongtuQqBridge
from test.test_merchant_alert import HTML, NOW
from astrbot_plugin_longtu_bridge.merchant_alert import parse_source, State


class CommandTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'state.sqlite'
        self.bridge = SimpleNamespace(session=None, _group_is_allowed=lambda e: True)
        self.event = SimpleNamespace(is_private_chat=lambda: False, get_group_id=lambda: '913546080',
            get_self_id=lambda: 'bot', get_sender_id=lambda: 'member',
            get_messages=lambda: [Comp.Plain('/远行商人')], send=AsyncMock(), stop_event=Mock(),
            message_obj=SimpleNamespace(message_id='command-1'), message_str='远行商人',
            bot=SimpleNamespace(call_action=AsyncMock(return_value={'message_id': 41}),
                api=SimpleNamespace(post_group_message=AsyncMock(return_value={'id': 'official-receipt'}))))
        self.snapshot = parse_source(HTML, NOW)
        self.patches = [patch.object(c, 'State', side_effect=lambda path: State(self.path)),
            patch.object(c, 'fetch_snapshot', AsyncMock(return_value=self.snapshot)),
            patch.object(c, 'fetch_icons', AsyncMock(return_value={})),
            patch.object(c, 'render_merchant_card', return_value=b'PNG'),
            patch.object(c.time, 'time', return_value=NOW),
            patch.object(o, 'prepare_image', AsyncMock(return_value={'file_info': 'stock-image'}))]
        for p in self.patches:
            p.start()

    async def asyncTearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    async def test_query_sends_fresh_image_without_subscription_mentions_and_replay_is_silent(self):
        self.assertTrue(await c.handle_merchant_command(self.bridge, self.event, '/远行商人'))
        segments = self.event.bot.call_action.call_args.kwargs['message']
        self.assertEqual([s['type'] for s in segments], ['text', 'image'])
        self.assertIn('刷新', segments[0]['data']['text'])
        c.render_merchant_card.assert_called_once_with(self.snapshot, [], {}, NOW)
        await c.handle_merchant_command(self.bridge, self.event, '/远行商人')
        self.event.bot.call_action.assert_awaited_once()
        c.fetch_snapshot.assert_awaited_once()
        # A fresh user command fetches again and is independent of scheduled state.
        self.event.message_obj.message_id = 'command-2'
        await c.handle_merchant_command(self.bridge, self.event, '/远行商人')
        self.assertEqual(c.fetch_snapshot.await_count, 2)
        db = State(self.path)
        self.assertEqual(db.db.execute('select count(*) from delivery').fetchone()[0], 2)
        db.close()

    async def test_official_passive_reply_uses_event_id_and_no_subscribers(self):
        await c.handle_merchant_command(self.bridge, self.event, '/远行商人', official=True)
        payload = self.event.bot.api.post_group_message.call_args.kwargs
        self.assertEqual(payload['msg_id'], 'command-1')
        self.assertEqual(payload['msg_type'], 7)
        self.assertNotIn('qqbot-at-user', payload['content'])
        self.assertEqual(payload['media'], {'file_info': 'stock-image'})
        self.event.bot.call_action.assert_not_awaited()
        await c.handle_merchant_command(self.bridge, self.event, '/远行商人', official=True)
        self.event.bot.api.post_group_message.assert_awaited_once()

    async def test_only_exact_command_private_and_group_permissions(self):
        self.assertFalse(await c.handle_merchant_command(self.bridge, self.event, '远行商人在哪里'))
        self.bridge._group_is_allowed = lambda e: False
        await c.handle_merchant_command(self.bridge, self.event, '/远行商人')
        self.event.send.assert_not_awaited()
        self.event.is_private_chat = lambda: True
        await c.handle_merchant_command(self.bridge, self.event, '/远行商人')
        self.assertIn('请在群里', self.event.send.call_args.args[0].chain[0].text)
        c.fetch_snapshot.assert_not_awaited()

    async def test_explicit_other_bot_and_concurrent_query_are_silent(self):
        self.event.get_messages = lambda: [Comp.At(qq='other'), Comp.Plain('/远行商人')]
        await c.handle_merchant_command(self.bridge, self.event, '/远行商人')
        c.fetch_snapshot.assert_not_awaited()
        self.event.get_messages = lambda: [Comp.At(qq='bot'), Comp.Plain('/远行商人')]
        lock = asyncio.Lock()
        self.bridge._merchant_command_locks = {('napcat', '913546080'): lock}
        async with lock:
            await c.handle_merchant_command(self.bridge, self.event, '/远行商人')
        c.fetch_snapshot.assert_not_awaited()

    async def test_closed_stale_and_round_changed_never_send_stock(self):
        with patch.object(c, 'round_window', return_value=None):
            await c.handle_merchant_command(self.bridge, self.event, '/远行商人')
        self.assertIn('休息', self.event.send.call_args.args[0].chain[0].text)
        c.fetch_snapshot.side_effect = ValueError('stale')
        await c.handle_merchant_command(self.bridge, self.event, '/远行商人')
        self.assertIn('不会用上一轮', self.event.send.call_args.args[0].chain[0].text)
        c.fetch_snapshot.side_effect = None
        clock_values = iter([NOW, NOW, self.snapshot['end']])
        with patch.object(c.time, 'time', side_effect=lambda: next(clock_values, self.snapshot['end'])):
            await c.handle_merchant_command(self.bridge, self.event, '/远行商人')
        self.event.bot.call_action.assert_not_awaited()

    async def test_unknown_send_and_missing_receipt_are_not_repeated(self):
        self.event.bot.call_action.side_effect = asyncio.TimeoutError()
        await c.handle_merchant_command(self.bridge, self.event, '/远行商人')
        await c.handle_merchant_command(self.bridge, self.event, '/远行商人')
        self.event.bot.call_action.assert_awaited_once()
        self.event.bot.api.post_group_message.return_value = {}
        await c.handle_merchant_command(self.bridge, self.event, '/远行商人', official=True)
        await c.handle_merchant_command(self.bridge, self.event, '/远行商人', official=True)
        self.event.bot.api.post_group_message.assert_awaited_once()
        self.event.send.assert_not_awaited()

    async def test_registered_legacy_and_adapter_dispatch_preserve_raw_slash(self):
        for mode in ('legacy', 'adapter'):
            self.bridge.transport_mode = mode
            self.bridge._raw_text = lambda event: '/远行商人'
            with patch.object(c, 'handle_merchant_command', AsyncMock(return_value=True)) as handle:
                result = [v async for v in LongtuQqBridge.on_qq_message(self.bridge, self.event)]
                self.assertEqual(result, [])
                handle.assert_awaited_once_with(self.bridge, self.event, '/远行商人')
        self.assertEqual(self.event.stop_event.call_count, 2)
