"""Per-item sale windows and durable daily subscriptions; all transports are mocked."""
from contextlib import closing
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch
from test import test_merchant_combined as combined
from test import test_merchant_official as official
from astrbot_plugin_longtu_bridge import merchant_alert as m
from astrbot_plugin_longtu_bridge import merchant_private as p

ROOT = Path(__file__).resolve().parents[1]


class DailySourceTests(unittest.TestCase):
    def test_public_sources_agree_on_prism_day_expiry(self):
        html = (ROOT / 'test/fixtures/merchant/prism-day.html').read_text()
        now = int(re.search(r'var serverNow = (\d+);', html)[1])
        primary = m.parse_source(html, now)
        data = json.loads((ROOT / 'test/fixtures/merchant/prism-day-proxy.json').read_text())
        proxy = m.parse_proxy(data, m.datetime.fromisoformat(data['fetchedAt'].replace('Z', '+00:00')).timestamp())
        for snapshot in (primary, proxy):
            prism = snapshot['items'][0]
            self.assertEqual(prism['name'], '棱镜球')
            self.assertTrue(m.daily_item(prism))
            self.assertEqual(prism['expiresAt'], snapshot['start'] + 16 * 3600)
            self.assertEqual(snapshot['items'][1]['expiresAt'], snapshot['end'])
            self.assertFalse(m.daily_item(snapshot['items'][1]))
        data['items'][0]['expiresAt'] = primary['end']
        with self.assertRaises(ValueError): m.parse_proxy(data, now)
        with self.assertRaises(ValueError):
            m.parse_source(html.replace(str(int(primary['items'][0]['expiresAt'])), str(int(primary['end']))), now)

    def test_daily_claim_is_atomic_per_recipient_and_rejected_attempt_can_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.sqlite'
            with closing(m.State(path)) as a, closing(m.State(path)) as b:
                self.assertTrue(a.claim('g:round1', 'stock', 1, ['g:day:prism']))
                self.assertFalse(b.claim('g:round2', 'duplicate', 2, ['g:day:prism']))
                self.assertIsNone(b.get('g:round2'))
                self.assertTrue(b.claim('private:round1', 'stock', 2, ['private:day:prism']))
                a.mark('g:round1', 'rejected', now=3)
                self.assertTrue(b.claim('g:round2', 'retry', 4, ['g:day:prism']))
                b.mark('g:round2', 'uncertain', now=5)
                self.assertFalse(a.claim('g:round3', 'unknown is held', 6, ['g:day:prism']))


class DailyDeliveryTests(combined.CombinedTests):
    test_group_and_exact_two_private_targets_survive_restart_without_duplicates = None
    test_existing_private_receipts_do_not_suppress_group = None
    test_group_rejection_does_not_block_private_and_retry_does_not_repeat_private = None
    test_private_rejection_does_not_repeat_successful_group = None
    test_missing_private_targets_never_inherits_four_group_mentions = None

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.monitor.bridge.config['merchant_expiry_reminder_enabled'] = True
        self.day_start = self.snap['start']
        self.snap['items'][1].update(name='棱镜球', rounds=[1, 2, 3, 4], expiresAt=self.day_start + 16 * 3600)
        self.set_round(1)

    def set_round(self, number, rare=False):
        self.snap.update(round=number, start=self.day_start + (number - 1) * 14400,
                         end=self.day_start + number * 14400)
        self.snap['fetchedAt'] = self.snap['start'] + 60
        for i, item in enumerate(self.snap['items']):
            if i != 1: item.update(rounds=[number], expiresAt=self.snap['end'])
        self.snap['items'][0]['name'] = '首领秘药'
        self.monitor.select.return_value = [0, 1] if rare else [1]

    async def tick_at(self, now):
        m.time.time.return_value = now
        return await self.monitor.tick(now)

    def text(self, call):
        return next(s['data']['text'] for s in call[1]['message'] if s['type'] == 'text')

    def reopen(self):
        path = self.monitor.state.db.execute('PRAGMA database_list').fetchone()[2]
        self.monitor.state.close()
        self.monitor.state = m.State(path)

    async def test_daily_only_sends_first_and_last_half_hour_across_four_rounds(self):
        for number in range(1, 5):
            self.set_round(number)
            await self.tick_at(self.snap['start'] + 60)
            await self.tick_at(self.snap['end'] - 1801)
            self.assertEqual(len(self.calls), 3)
            await self.tick_at(self.snap['end'] - 1800)
            self.assertEqual(len(self.calls), 6 if number == 4 else 3)
            self.reopen()
        for call in self.calls[:3]:
            self.assertIn('当天售卖', self.text(call))
            self.assertIn('24:00', self.text(call))
            self.assertNotIn('12:00', self.text(call))
        for call in self.calls[3:]:
            self.assertIn('最后30分钟', self.text(call))
            self.assertIn('棱镜球', self.text(call))
        await self.tick_at(self.snap['end'] - 60)
        await self.tick_at(self.snap['end'])
        self.assertEqual(len(self.calls), 6)
        self.monitor._tick_official.assert_not_awaited()

    async def test_other_rares_keep_round_introduction_and_expiry_without_realerting_daily(self):
        await self.tick_at(self.snap['start'] + 60)
        self.set_round(2, rare=True)
        await self.tick_at(self.snap['start'] + 60)
        await self.tick_at(self.snap['end'] - 1800)
        self.assertEqual(len(self.calls), 9)
        for call in self.calls[3:]:
            self.assertIn('首领秘药', self.text(call))
            self.assertNotIn('棱镜球', self.text(call))
        self.assertEqual(p.render_merchant_card.call_args.args[1], [0])
        self.set_round(3)
        await self.tick_at(self.snap['end'] - 1800)
        self.assertEqual(len(self.calls), 9)
        self.set_round(4, rare=True)
        await self.tick_at(self.snap['start'] + 60)
        await self.tick_at(self.snap['end'] - 1800)
        self.assertEqual(len(self.calls), 15)
        for call in self.calls[-3:]:
            self.assertIn('首领秘药', self.text(call))
            self.assertIn('棱镜球', self.text(call))
        self.assertEqual(p.render_merchant_card.call_args.args[1], [0, 1])

    async def test_old_receipts_are_imported_without_changing_or_resending_them(self):
        now = self.day_start + 60
        for destination in ('913546080', 'private:1079175957', 'private:2584778797'):
            key = f'{destination}:{int(self.day_start)}'
            self.monitor.state.claim(key, '远行商人稀有道具上架：棱镜球\n旧版本误写距12:00刷新', now)
            self.monitor.state.mark(key, 'sent', 'old-receipt', now)
        self.set_round(2)
        await self.tick_at(self.snap['start'] + 60)
        await self.tick_at(self.snap['end'] - 1800)
        self.assertEqual(self.calls, [])
        self.reopen()
        self.set_round(4)
        await self.tick_at(self.snap['end'] - 1800)
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(self.monitor.state.get(f'913546080:{int(self.day_start)}')[2], 'old-receipt')

    async def test_first_seen_in_last_half_hour_is_one_message_and_next_day_is_independent(self):
        self.set_round(4)
        await self.tick_at(self.snap['end'] - 1600)
        await self.tick_at(self.snap['end'] - 1200)
        self.assertEqual(len(self.calls), 3)
        self.day_start += 86400
        self.snap['items'][1]['expiresAt'] += 86400
        self.set_round(1)
        await self.tick_at(self.snap['start'] + 60)
        self.assertEqual(len(self.calls), 6)

    async def test_failure_does_not_mark_another_recipient_or_block_round_rares(self):
        self.fail = 'send_private_msg'
        with self.assertRaises(RuntimeError): await self.tick_at(self.snap['start'] + 60)
        self.fail = None
        self.set_round(2, rare=True)
        await self.tick_at(self.snap['start'] + 60)
        self.assertNotIn('棱镜球', self.text(self.calls[3]))
        self.assertIn('棱镜球', self.text(self.calls[4]))
        self.assertIn('棱镜球', self.text(self.calls[5]))
        await self.tick_at(self.snap['end'] - 1800)
        for call in self.calls[-3:]: self.assertNotIn('棱镜球', self.text(call))

    async def test_disabled_reminder_keeps_one_daily_introduction(self):
        self.monitor.bridge.config['merchant_expiry_reminder_enabled'] = False
        await self.tick_at(self.snap['start'] + 60)
        self.set_round(4)
        await self.tick_at(self.snap['start'] + 60)
        await self.tick_at(self.snap['end'] - 1800)
        self.assertEqual(len(self.calls), 3)


class OfficialDailyTests(official.ScheduledTests):
    async def test_official_daily_first_and_last_reminder_use_markdown_and_keep_members(self):
        start = self.snap['start']
        self.monitor.bridge.config['merchant_expiry_reminder_enabled'] = True
        self.snap['items'][1].update(name='棱镜球', rounds=[1, 2, 3, 4], expiresAt=start + 57600)
        for number in range(1, 5):
            self.snap.update(round=number, start=start+(number-1)*14400, end=start+number*14400)
            for now in (self.snap['start'] + 60, self.snap['end'] - 1800):
                m.time.time.return_value = now
                await self.monitor._tick_official(now)
            self.assertEqual(self.client.api.post_group_message.await_count, 2 if number == 4 else 1)
        payload = self.client.api.post_group_message.call_args.kwargs
        self.assertEqual(payload['msg_type'], 2)
        self.assertIn('最后30分钟', payload['markdown']['content'])
        for member in official.OPENIDS:
            self.assertIn(f'<qqbot-at-user id="{member}" />', payload['markdown']['content'])
