"""Verified official identities and durable delivery; no live API calls."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import unittest
from test import test_merchant_alert as fixtures
from test.test_merchant_alert import NOW
from astrbot_plugin_longtu_bridge import merchant_official as o

MEMBERS = ['1079175957', '2584778797', '1299971625', '1846366057']
GROUP = 'verified-group-openid'
OPENIDS = ['verified-member-' + str(i) for i in range(4)]


def config():
    return dict(merchant_official_enabled=True, official_trial_enabled=True,
                official_trial_appid='app-test',
                official_trial_group_bindings=json.dumps({GROUP: {'qq_group_id': '913546080'}}),
                merchant_official_member_bindings=json.dumps({GROUP: dict(zip(MEMBERS, OPENIDS))}))


class IdentityTests(unittest.TestCase):
    def test_only_exact_verified_target_and_all_four_unique_members(self):
        self.assertEqual(o.scheduled_target(config(), '913546080', MEMBERS), (GROUP, OPENIDS))
        for changed in [dict(merchant_official_enabled=False), dict(official_trial_enabled=False),
                        dict(official_trial_group_bindings=json.dumps({GROUP: {'qq_group_id': '1109147947'}})),
                        dict(merchant_official_member_bindings='{}'),
                        dict(merchant_official_member_bindings=json.dumps({GROUP: dict(zip(MEMBERS, MEMBERS))})),
                        dict(merchant_official_member_bindings=json.dumps({GROUP: dict.fromkeys(MEMBERS, OPENIDS[0])})),
                        dict(official_trial_group_bindings=json.dumps({GROUP: {'qq_group_id': '913546080'},
                                                'duplicate-group': {'qq_group_id': '913546080'}}))]:
            self.assertIsNone(o.scheduled_target(dict(config(), **changed), '913546080', MEMBERS))


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_single_native_mention_image_message_with_receipt(self):
        client = SimpleNamespace(api=SimpleNamespace(post_group_message=AsyncMock(return_value={'id': 'receipt'})))
        self.assertEqual(await o.send_image(client, GROUP, {'file_info': 'image'}, 'stock', OPENIDS), 'receipt')
        payload = client.api.post_group_message.call_args.kwargs
        self.assertEqual(payload['msg_type'], 7)
        self.assertNotIn('msg_id', payload)
        for qq, oid in zip(MEMBERS, OPENIDS):
            self.assertIn(f'<qqbot-at-user id="{oid}" />', payload['content'])
            self.assertNotIn(qq, payload['content'])
        await o.send_image(client, GROUP, {}, 'query', reply_id='incoming')
        self.assertEqual(client.api.post_group_message.call_args.kwargs['msg_id'], 'incoming')
        self.assertEqual(client.api.post_group_message.call_args.kwargs['content'], 'query')
        client.api.post_group_message.return_value = {}
        with self.assertRaises(RuntimeError):
            await o.send_image(client, GROUP, {}, 'unknown')


class ScheduledTests(fixtures.DeliveryTests):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.monitor.bridge.config = config()
        self.client = SimpleNamespace(api=SimpleNamespace(post_group_message=AsyncMock(return_value={'id': 'official-1'})))
        self.monitor.bridge.context = SimpleNamespace(platform_manager=SimpleNamespace(platform_insts=[
            SimpleNamespace(meta=lambda: SimpleNamespace(name='qq_official'), appid='app-test', client=self.client)]))
        self.upload = patch.object(o, 'prepare_image', AsyncMock(return_value={'file_info': 'image'}))
        self.upload.start()

    async def asyncTearDown(self):
        self.upload.stop()
        await super().asyncTearDown()

    # Reuse setup/teardown only; parent expectations describe NapCat-only mode.
    test_single_message_contains_image_and_four_real_at_segments = None
    test_no_targets_or_missing_image_never_mentions_anyone = None
    test_uncertain_send_is_recovered_from_own_history_without_resend = None
    test_definite_rejection_can_retry_but_expired_round_cannot_send = None

    async def test_both_channels_share_current_snapshot_and_deduplicate(self):
        from astrbot_plugin_longtu_bridge import merchant_alert as m
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=sent official=sent')
        m.fetch_snapshot.assert_awaited_once()
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=already-sent official=already-sent')
        path = self.monitor.state.db.execute('PRAGMA database_list').fetchone()[2]
        self.monitor.state.close()
        self.monitor.state = m.State(path)
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=already-sent official=already-sent')
        self.client.api.post_group_message.assert_awaited_once()
        self.bot.call_action.assert_awaited_once()

    async def test_absent_target_never_uploads_or_sends(self):
        self.monitor.bridge.config['merchant_official_member_bindings'] = '{}'
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=sent official=waiting-verified-group-and-members')
        o.prepare_image.assert_not_awaited()
        self.client.api.post_group_message.assert_not_awaited()

    async def test_napcat_failure_does_not_block_official(self):
        self.bot.call_action.side_effect = asyncio.TimeoutError()
        with self.assertRaises(RuntimeError):
            await self.monitor.tick(NOW)
        self.client.api.post_group_message.assert_awaited_once()

    async def test_official_timeout_held_without_duplicate_after_reload(self):
        self.client.api.post_group_message.side_effect = asyncio.TimeoutError()
        with self.assertRaises(RuntimeError):
            await self.monitor.tick(NOW)
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=already-sent official=uncertain-held')
        self.client.api.post_group_message.assert_awaited_once()

    async def test_upload_failure_can_retry_before_visible_send(self):
        o.prepare_image.side_effect = ValueError('upload unavailable')
        with self.assertRaises(RuntimeError):
            await self.monitor.tick(NOW)
        self.client.api.post_group_message.assert_not_awaited()
        o.prepare_image.side_effect = None
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=already-sent official=sent')

    async def test_upload_finishing_after_round_never_sends_or_claims(self):
        from astrbot_plugin_longtu_bridge import merchant_alert as m
        async def expired_upload(*args):
            m.time.time.return_value = self.snap['end']
            return {'file_info': 'image'}
        o.prepare_image.side_effect = expired_upload
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=sent official=expired-before-send')
        self.client.api.post_group_message.assert_not_awaited()
        self.assertEqual(self.monitor.state.db.execute('select count(*) from delivery').fetchone()[0], 1)
