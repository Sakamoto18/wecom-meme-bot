"""Mixed delivery must reach each destination once, with independent failures."""
import asyncio
from unittest.mock import AsyncMock, patch
from test import test_merchant_alert as fixtures
from astrbot_plugin_longtu_bridge import merchant_private as p
from astrbot_plugin_longtu_bridge import merchant_alert as m

class CombinedTests(fixtures.DeliveryTests):
    test_single_message_contains_image_and_four_real_at_segments = None
    test_no_targets_or_missing_image_never_mentions_anyone = None
    test_uncertain_send_is_recovered_from_own_history_without_resend = None
    test_definite_rejection_can_retry_but_expired_round_cannot_send = None

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.monitor.bridge.config = {'merchant_alert_delivery': 'group_private',
            'merchant_private_recipients': '1079175957,2584778797', 'merchant_official_enabled': False}
        self.monitor._tick_official = AsyncMock()
        self.calls = []
        self.fail = None
        async def action(name, **params):
            if name == 'get_friend_list':
                return [{'user_id': int(u)} for u in self.monitor.mentions]
            self.calls.append((name, params))
            if name == self.fail:
                return {'status':'failed', 'retcode':100}
            return {'message_id': 700+len(self.calls)}
        self.bot.call_action.side_effect = action
        self.patches += [patch.object(p, 'fetch_icons', AsyncMock(return_value={})),
                         patch.object(p, 'render_merchant_card', return_value=b'PNG')]
        for patcher in self.patches[-2:]: patcher.start()

    async def test_group_and_exact_two_private_targets_survive_restart_without_duplicates(self):
        await self.monitor.tick(fixtures.NOW)
        group = [args for name,args in self.calls if name == 'send_group_msg']
        private = [args for name,args in self.calls if name == 'send_private_msg']
        self.assertEqual([x['group_id'] for x in group], [913546080])
        self.assertEqual([x['user_id'] for x in private], [1079175957,2584778797])
        self.assertEqual([x['data']['qq'] for x in group[0]['message'] if x['type']=='at'], self.monitor.mentions)
        for args in private:
            self.assertNotIn('group_id', args)
            self.assertEqual([s['type'] for s in args['message']], ['text','image'])
        m.fetch_snapshot.assert_awaited_once()
        path=self.monitor.state.db.execute('PRAGMA database_list').fetchone()[2]
        self.monitor.state.close(); self.monitor.state=m.State(path)
        await self.monitor.tick(fixtures.NOW)
        self.assertEqual(len(self.calls),3)
        self.monitor._tick_official.assert_not_awaited()

    async def test_existing_private_receipts_do_not_suppress_group(self):
        for user in ['1079175957','2584778797']:
            key=f'private:{user}:{int(self.snap["start"])}'
            self.monitor.state.claim(key,'old',fixtures.NOW)
            self.monitor.state.mark(key,'sent','old')
        await self.monitor.tick(fixtures.NOW)
        self.assertEqual([n for n,_ in self.calls],['send_group_msg'])

    async def test_group_rejection_does_not_block_private_and_retry_does_not_repeat_private(self):
        self.fail='send_group_msg'
        with self.assertRaises(RuntimeError):await self.monitor.tick(fixtures.NOW)
        self.assertEqual(len(self.calls),3)
        self.fail=None
        await self.monitor.tick(fixtures.NOW)
        self.assertEqual([n for n,_ in self.calls].count('send_private_msg'),2)
        self.assertEqual([n for n,_ in self.calls].count('send_group_msg'),2)

    async def test_private_rejection_does_not_repeat_successful_group(self):
        self.fail='send_private_msg'
        with self.assertRaises(RuntimeError):await self.monitor.tick(fixtures.NOW)
        self.fail=None
        await self.monitor.tick(fixtures.NOW)
        self.assertEqual([n for n,_ in self.calls].count('send_group_msg'),1)
        self.assertEqual([n for n,_ in self.calls].count('send_private_msg'),4)

    async def test_missing_private_targets_never_inherits_four_group_mentions(self):
        del self.monitor.bridge.config['merchant_private_recipients']
        with self.assertRaises(RuntimeError):await self.monitor.tick(fixtures.NOW)
        self.assertEqual([n for n,_ in self.calls],['send_group_msg'])
