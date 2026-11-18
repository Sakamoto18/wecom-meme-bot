"""Private subscriptions use fake OneBot I/O and real temporary delivery state."""
import asyncio
from unittest.mock import AsyncMock, patch
from test import test_merchant_alert as fixtures
from astrbot_plugin_longtu_bridge import merchant_private as p
from astrbot_plugin_longtu_bridge import merchant_alert as m

NOW = fixtures.NOW


class PrivateTests(fixtures.DeliveryTests):
    test_single_message_contains_image_and_four_real_at_segments = None
    test_no_targets_or_missing_image_never_mentions_anyone = None
    test_uncertain_send_is_recovered_from_own_history_without_resend = None
    test_definite_rejection_can_retry_but_expired_round_cannot_send = None

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.friends = list(self.monitor.mentions)
        self.monitor.bridge.config = {'merchant_alert_delivery': 'private', 'merchant_official_enabled': True}
        self.monitor._tick_napcat = AsyncMock(side_effect=AssertionError('No group send'))
        self.monitor._tick_official = AsyncMock(side_effect=AssertionError('No official group send'))
        self.patches += [patch.object(p, 'fetch_icons', AsyncMock(return_value={})),
                         patch.object(p, 'render_merchant_card', return_value=b'PNG')]
        for item in self.patches[-2:]:
            item.start()
        self.private_calls = []
        self.fail_user = None
        async def action(name, **params):
            if name == 'get_friend_list':
                return [{'user_id': int(u)} for u in self.friends]
            self.assertEqual(name, 'send_private_msg')
            self.assertNotIn('group_id', params)
            self.private_calls.append(params)
            if params['user_id'] == self.fail_user:
                raise asyncio.TimeoutError()
            return {'message_id': 900 + len(self.private_calls)}
        self.bot.call_action.side_effect = action

    async def test_four_separate_private_images_no_mentions_or_group_fallback_and_durable_dedup(self):
        status = await self.monitor.tick(NOW)
        self.assertEqual(len(self.private_calls), 4)
        self.assertEqual([str(c['user_id']) for c in self.private_calls], self.monitor.mentions)
        for call in self.private_calls:
            self.assertEqual([s['type'] for s in call['message']], ['text', 'image'])
        self.assertEqual(status.count('=sent'), 4)
        m.fetch_snapshot.assert_awaited_once()
        p.render_merchant_card.assert_called_once()
        db_path = self.monitor.state.db.execute('PRAGMA database_list').fetchone()[2]
        self.monitor.state.close()
        self.monitor.state = m.State(db_path)
        self.assertEqual((await self.monitor.tick(NOW)).count('already-sent'), 4)
        self.assertEqual(len(self.private_calls), 4)
        self.monitor._tick_napcat.assert_not_awaited()
        self.monitor._tick_official.assert_not_awaited()

    async def test_nonfriends_wait_and_can_receive_after_becoming_friends(self):
        self.friends = self.monitor.mentions[:2]
        status = await self.monitor.tick(NOW)
        self.assertEqual(status.count('waiting-friend'), 2)
        self.assertEqual(len(self.private_calls), 2)
        self.friends = list(self.monitor.mentions)
        await self.monitor.tick(NOW)
        self.assertEqual(len(self.private_calls), 4)

    async def test_timeout_for_one_does_not_block_other_members_or_resend(self):
        self.fail_user = int(self.monitor.mentions[0])
        with self.assertRaises(RuntimeError):
            await self.monitor.tick(NOW)
        self.assertEqual(len(self.private_calls), 4)
        self.assertIn('uncertain-held', await self.monitor.tick(NOW))
        self.assertEqual(len(self.private_calls), 4)

    async def test_no_friends_or_no_subscribed_goods_never_sends(self):
        self.friends = []
        self.assertEqual((await self.monitor.tick(NOW)).count('waiting-friend'), 4)
        m.fetch_snapshot.assert_not_awaited()
        self.friends = self.monitor.mentions
        self.monitor.select.return_value = []
        self.assertIn('no-subscribed-goods', await self.monitor.tick(NOW))
        self.assertEqual(self.private_calls, [])

    async def test_friend_lookup_failure_never_falls_back_and_expiry_checked_per_recipient(self):
        self.bot.call_action.side_effect = RuntimeError('offline')
        with self.assertRaises(RuntimeError):
            await self.monitor.tick(NOW)
        self.monitor._tick_napcat.assert_not_awaited()
        self.monitor._tick_official.assert_not_awaited()
        async def action(name, **params):
            if name == 'get_friend_list':
                return [{'user_id': u} for u in self.friends]
            self.private_calls.append(params)
            m.time.time.return_value = self.snap['end']
            return {'message_id': 71}
        self.bot.call_action.side_effect = action
        status = await self.monitor.tick(NOW)
        self.assertEqual(len(self.private_calls), 1)
        self.assertEqual(status.count('expired-before-send'), 3)

    async def test_invalid_mode_cannot_leak_into_group(self):
        self.monitor.bridge.config['merchant_alert_delivery'] = 'privtae'
        with self.assertRaises(ValueError):
            await self.monitor.tick(NOW)
        self.bot.call_action.assert_not_awaited()
