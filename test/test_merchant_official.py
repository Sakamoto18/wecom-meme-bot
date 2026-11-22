"""Verified official identities and durable delivery; no live API calls."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
import unittest
from test import test_merchant_alert as fixtures
from test.test_merchant_alert import NOW
from astrbot_plugin_longtu_bridge import merchant_official as o

MEMBERS = ['1079175957', '2584778797', '1299971625', '1846366057']
GROUP = 'verified-group-openid'
OPENIDS = ['verified-member-' + str(i) for i in range(4)]
IMAGE = o.MentionImage('qqbot-media://image/v1/stock', 1080, 900)


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
    async def test_permission_check_requires_an_explicit_boolean_from_qq(self):
        for flag in (True, False):
            with patch.object(o, 'group_bot_state', AsyncMock(return_value={'allow_proactive_msg': flag})):
                self.assertIs(await o.proactive_allowed(None, GROUP), flag)
        for state in ({}, None, {'allow_proactive_msg': 'true'}, {'allow_proactive_msg': 1}):
            with patch.object(o, 'group_bot_state', AsyncMock(return_value=state)):
                with self.assertRaises(RuntimeError):
                    await o.proactive_allowed(None, GROUP)

    async def test_single_native_mention_image_message_with_receipt(self):
        client = SimpleNamespace(api=SimpleNamespace(post_group_message=AsyncMock(return_value={'id': 'receipt'})))
        self.assertEqual(await o.send_image(client, GROUP, IMAGE, 'stock', OPENIDS), 'receipt')
        payload = client.api.post_group_message.call_args.kwargs
        self.assertEqual(payload['msg_type'], 2)
        self.assertNotIn('content', payload)
        self.assertNotIn('media', payload)
        self.assertTrue(payload['markdown']['force_verify_image_resource'])
        self.assertIn('![远行商人库存 #1080px #900px](qqbot-media://image/v1/stock)', payload['markdown']['content'])
        client.api.post_group_message.assert_awaited_once()
        self.assertNotIn('msg_id', payload)
        for qq, oid in zip(MEMBERS, OPENIDS):
            self.assertIn(f'<qqbot-at-user id="{oid}" />', payload['markdown']['content'])
            self.assertNotIn(qq, payload['markdown']['content'])
        await o.send_image(client, GROUP, {}, 'query', reply_id='incoming')
        self.assertEqual(client.api.post_group_message.call_args.kwargs['msg_id'], 'incoming')
        self.assertEqual(client.api.post_group_message.call_args.kwargs['content'], 'query')
        self.assertEqual(client.api.post_group_message.call_args.kwargs['msg_type'], 7)
        client.api.post_group_message.return_value = {}
        with self.assertRaises(RuntimeError):
            await o.send_image(client, GROUP, {}, 'unknown')

    async def test_member_mentions_cannot_be_sent_as_literal_rich_media(self):
        client = SimpleNamespace(api=SimpleNamespace(post_group_message=AsyncMock()))
        for media, members in (({'file_info': 'image'}, OPENIDS),
                               (IMAGE, ['bad" />']),
                               (o.MentionImage('https://example/image', 1080, 900), OPENIDS)):
            with self.assertRaises(ValueError):
                await o.send_image(client, GROUP, media, 'stock', members)
        client.api.post_group_message.assert_not_awaited()

    async def test_stock_text_is_literal_and_unconfirmed_markdown_is_not_retried(self):
        client = SimpleNamespace(api=SimpleNamespace(post_group_message=AsyncMock(return_value={})))
        with self.assertRaises(RuntimeError):
            await o.send_image(client, GROUP, IMAGE,
                '<qqbot-at-everyone /> [stock](https://example) *item*', OPENIDS)
        payload = client.api.post_group_message.call_args.kwargs
        content = payload['markdown']['content']
        self.assertEqual(content.count('<qqbot-at-user '), len(OPENIDS))
        self.assertNotIn('<qqbot-at-everyone', content)
        self.assertIn(r'\[stock\]\(https://example\)', content)
        self.assertIn(r'\*item\*', content)
        client.api.post_group_message.assert_awaited_once()


class ScheduledTests(fixtures.DeliveryTests):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.monitor.bridge.config = config()
        self.client = SimpleNamespace(api=SimpleNamespace(post_group_message=AsyncMock(return_value={'id': 'official-1'})))
        self.monitor.bridge.context = SimpleNamespace(platform_manager=SimpleNamespace(platform_insts=[
            SimpleNamespace(meta=lambda: SimpleNamespace(name='qq_official'), appid='app-test', client=self.client)]))
        self.prepared = MagicMock()
        self.prepared.__aenter__.return_value = IMAGE
        self.upload = patch.object(o, 'prepare_mention_image', return_value=self.prepared)
        self.upload.start()
        self.permission = patch.object(o, 'proactive_allowed', AsyncMock(return_value=True))
        self.permission.start()

    async def asyncTearDown(self):
        self.permission.stop()
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
        self.prepared.__aexit__.assert_awaited_once()
        self.bot.call_action.assert_awaited_once()

    async def test_absent_target_never_uploads_or_sends(self):
        self.monitor.bridge.config['merchant_official_member_bindings'] = '{}'
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=sent official=waiting-verified-group-and-members')
        o.prepare_mention_image.assert_not_called()
        self.client.api.post_group_message.assert_not_awaited()

    async def test_disabled_permission_waits_without_claim_then_recovers_same_round(self):
        from astrbot_plugin_longtu_bridge import merchant_alert as m
        o.proactive_allowed.return_value = False
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=sent official=waiting-group-proactive-permission')
        self.assertEqual(self.monitor.state.db.execute("select count(*) from delivery where key like 'official:%'").fetchone()[0], 0)
        o.prepare_mention_image.assert_not_called()
        self.client.api.post_group_message.assert_not_awaited()
        path = self.monitor.state.db.execute('PRAGMA database_list').fetchone()[2]
        self.monitor.state.close()
        self.monitor.state = m.State(path)
        o.proactive_allowed.return_value = True
        self.assertEqual(await self.monitor.tick(NOW + 30), 'napcat=already-sent official=sent')
        self.assertEqual(await self.monitor.tick(NOW + 60), 'napcat=already-sent official=already-sent')
        self.client.api.post_group_message.assert_awaited_once()

    async def test_permission_lookup_failure_never_uploads_or_claims(self):
        o.proactive_allowed.side_effect = asyncio.TimeoutError()
        with self.assertRaises(RuntimeError):
            await self.monitor.tick(NOW)
        self.assertEqual(self.monitor.state.db.execute("select count(*) from delivery where key like 'official:%'").fetchone()[0], 0)
        o.prepare_mention_image.assert_not_called()
        self.client.api.post_group_message.assert_not_awaited()

    async def test_all_five_subscribers_use_scoped_openids_and_missing_fifth_blocks_send(self):
        self.monitor.mentions.append('1104886947')
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=sent official=waiting-verified-group-and-members')
        self.client.api.post_group_message.assert_not_awaited()
        members = dict(zip(MEMBERS, OPENIDS))
        members['1104886947'] = 'verified-member-4'
        # A mapping in a different group must never authorize this group's @.
        self.monitor.bridge.config['merchant_official_member_bindings'] = {GROUP: dict(zip(MEMBERS, OPENIDS)),
                                                                         'other-group-openid': members}
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=already-sent official=waiting-verified-group-and-members')
        self.client.api.post_group_message.assert_not_awaited()
        self.monitor.bridge.config['merchant_official_member_bindings'] = {GROUP: members}
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=already-sent official=sent')
        payload = self.client.api.post_group_message.call_args.kwargs
        self.assertEqual(payload['group_openid'], GROUP)
        self.assertEqual(payload['msg_type'], 2)
        self.assertNotIn('msg_id', payload)
        self.assertEqual(payload['markdown']['content'].count('<qqbot-at-user '), 5)
        for qq, oid in members.items():
            self.assertIn(f'<qqbot-at-user id="{oid}" />', payload['markdown']['content'])
            self.assertNotIn(qq, payload['markdown']['content'])
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=already-sent official=already-sent')
        self.client.api.post_group_message.assert_awaited_once()

    async def test_napcat_failure_does_not_block_official(self):
        self.bot.call_action.side_effect = asyncio.TimeoutError()
        with self.assertRaises(RuntimeError):
            await self.monitor.tick(NOW)
        self.client.api.post_group_message.assert_awaited_once()

    async def test_official_timeout_held_without_duplicate_after_reload(self):
        self.client.api.post_group_message.side_effect = asyncio.TimeoutError()
        with self.assertRaises(RuntimeError):
            await self.monitor.tick(NOW)
        self.prepared.__aexit__.assert_awaited_once()
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=already-sent official=uncertain-held')
        self.client.api.post_group_message.assert_awaited_once()

    async def test_upload_failure_can_retry_before_visible_send(self):
        self.prepared.__aenter__.side_effect = ValueError('upload unavailable')
        with self.assertRaises(RuntimeError):
            await self.monitor.tick(NOW)
        self.client.api.post_group_message.assert_not_awaited()
        self.prepared.__aenter__.side_effect = None
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=already-sent official=sent')

    async def test_upload_finishing_after_round_never_sends_or_claims(self):
        from astrbot_plugin_longtu_bridge import merchant_alert as m
        async def expired_upload(*args):
            m.time.time.return_value = self.snap['end']
            return IMAGE
        self.prepared.__aenter__.side_effect = expired_upload
        self.assertEqual(await self.monitor.tick(NOW), 'napcat=sent official=expired-before-send')
        self.prepared.__aexit__.assert_awaited_once()
        self.client.api.post_group_message.assert_not_awaited()
        self.assertEqual(self.monitor.state.db.execute('select count(*) from delivery').fetchone()[0], 1)

    async def test_lost_claim_releases_prepared_material_without_sending(self):
        with patch.object(self.monitor.state, 'claim', return_value=False):
            self.assertEqual(await self.monitor._tick_official(NOW), 'claimed-by-another-worker')
        self.prepared.__aexit__.assert_awaited_once()
        self.client.api.post_group_message.assert_not_awaited()

    async def test_cancelled_send_is_held_and_prepared_material_is_released(self):
        self.client.api.post_group_message.side_effect = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.monitor._tick_official(NOW)
        self.prepared.__aexit__.assert_awaited_once()
        self.assertEqual(await self.monitor._tick_official(NOW), 'uncertain-held')
        self.client.api.post_group_message.assert_awaited_once()
