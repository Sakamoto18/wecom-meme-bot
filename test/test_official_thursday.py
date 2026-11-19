"""Real AstrBot imports, simulated transports only; never publish test broadcasts."""
import asyncio
from datetime import date
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from astrbot_plugin_longtu_bridge import official_trial as o
from astrbot_plugin_longtu_bridge.main import LongtuQqBridge

DAY=date(2026,11,19)
class ThursdayTests(unittest.IsolatedAsyncioTestCase):
    def bridge(self, groups='group-a'):
        return SimpleNamespace(config={'official_trial_enabled':True,'official_trial_push_enabled':True,
            'official_trial_push_groups':groups,'merchant_official_enabled':False},
            _generate_crazy_thursday_text=AsyncMock(return_value='sample'),_send_crazy_thursday=AsyncMock())

    async def test_empty_targets_are_explicit_and_do_not_generate_or_send(self):
        b=self.bridge('')
        with patch.object(o,'proactive',AsyncMock()) as send, patch.object(o.logger,'warning') as warn:
            self.assertEqual(await o.mirror_crazy_thursday(b,DAY),0)
            send.assert_not_awaited();b._generate_crazy_thursday_text.assert_not_awaited()
            self.assertIn('no-target-groups',warn.call_args.args[0])

    async def test_explicit_groups_deduplicated_and_merchant_toggle_independent(self):
        b=self.bridge('group-a, group-a,group-b')
        with patch.object(o,'proactive',AsyncMock(return_value=True)) as send:
            self.assertEqual(await o.mirror_crazy_thursday(b,DAY),2)
            self.assertEqual([c.args[1] for c in send.call_args_list],['group-a','group-b'])
            self.assertTrue(all(c.kwargs['group'] for c in send.call_args_list))
            b._generate_crazy_thursday_text.assert_awaited_once()

    async def test_false_and_exception_not_reported_as_success_other_group_continues(self):
        b=self.bridge('a,b,c')
        with patch.object(o,'proactive',AsyncMock(side_effect=[False,RuntimeError(),True])) as send:
            self.assertEqual(await o.mirror_crazy_thursday(b,DAY),1)
            self.assertEqual(send.await_count,3)

    async def test_disabled_never_sends(self):
        b=self.bridge();b.config['official_trial_push_enabled']=False
        with patch.object(o,'proactive',AsyncMock()) as send:
            self.assertEqual(await o.mirror_crazy_thursday(b,DAY),0)
            send.assert_not_awaited()

    async def test_napcat_exception_does_not_suppress_official(self):
        b=self.bridge();b._send_crazy_thursday.side_effect=RuntimeError('offline')
        with patch.object(o,'mirror_crazy_thursday',AsyncMock()) as send:
            await LongtuQqBridge._dispatch_crazy_thursday(b,DAY)
            send.assert_awaited_once_with(b,DAY)

    async def test_official_exception_does_not_break_next_slot_or_napcat(self):
        b=self.bridge()
        with patch.object(o,'mirror_crazy_thursday',AsyncMock(side_effect=RuntimeError())):
            await LongtuQqBridge._dispatch_crazy_thursday(b,DAY)
            b._send_crazy_thursday.assert_awaited_once_with(DAY)

    async def test_cancellation_is_not_swallowed(self):
        b=self.bridge();b._send_crazy_thursday.side_effect=asyncio.CancelledError()
        with patch.object(o,'mirror_crazy_thursday',AsyncMock()) as send:
            with self.assertRaises(asyncio.CancelledError):
                await LongtuQqBridge._dispatch_crazy_thursday(b,DAY)
            send.assert_not_awaited()
