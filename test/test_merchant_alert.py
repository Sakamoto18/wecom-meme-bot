import asyncio
import io
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from astrbot_plugin_longtu_bridge import merchant_alert as m
from astrbot_plugin_longtu_bridge.merchant_card import render_merchant_card

HTML = (ROOT / 'test/fixtures/merchant/current.html').read_text(encoding='utf8')
NOW = int(re.search(r'var serverNow = (\d+);', HTML)[1])


class EvidenceTests(unittest.TestCase):
    def test_real_source_round_images_prices_and_reject_stale_pages(self):
        snapshot = m.parse_source(HTML, NOW)
        self.assertEqual([i['name'] for i in snapshot['items']], ['蓝晶碧玺', '神奇的蛋', '翼系粉尘'])
        self.assertEqual(snapshot['items'][1]['price'], '36000')
        self.assertTrue(snapshot['items'][1]['image'].startswith('https://img.71acg.net/'))
        self.assertEqual(snapshot['round'], 1)
        for html, now in [(HTML, NOW + 86400), (HTML, snapshot['end']), (HTML, NOW + 121), ('<html>blocked</html>', NOW)]:
            with self.assertRaises(ValueError):
                m.parse_source(html, now)
        # A fresh server clock cannot turn previous-round goods into new stock.
        with self.assertRaises(ValueError):
            m.parse_source(HTML.replace(str(NOW), str(int(snapshot['end']))), snapshot['end'])

    def test_midnight_and_precise_refresh_polling(self):
        start = m.round_window(NOW)[1]
        self.assertEqual(m.poll_delay(start), 15)
        self.assertEqual(m.poll_delay(start + 400), 60)
        self.assertEqual(m.poll_delay(start + 1000), 300)
        self.assertEqual(m.retry_delay(start + 1000, 1), 15)
        self.assertEqual(m.retry_delay(start + 1000, 5), 240)
        self.assertEqual(m.retry_delay(start + 4 * 3600 - 2, 5), 2)
        self.assertEqual(m.poll_delay(start + 4 * 3600 - 2), 2)
        midnight = start + 16 * 3600
        self.assertIsNone(m.round_window(midnight))
        self.assertEqual(m.poll_delay(midnight), 8 * 3600)

    def test_proxy_requires_current_round_and_fresh_timestamp(self):
        _, start, end = m.round_window(NOW)
        bj = lambda ts: m.datetime.fromtimestamp(ts, m.BJ).strftime('%Y-%m-%d %H:%M:%S')
        data = dict(live=True, stale=False, status='open', round=1, expectedRound=1,
                    startedAtBeijing=bj(start), nextRefreshBeijing=bj(end),
                    fetchedAt=m.datetime.fromtimestamp(NOW, m.BJ).isoformat(),
                    items=m.parse_source(HTML, NOW)['items'])
        self.assertEqual(len(m.parse_proxy(data, NOW)['items']), 3)
        for altered in [dict(data, stale=True), dict(data, round=2), dict(data, fetchedAt='2026-11-17T01:00:00Z')]:
            with self.assertRaises(ValueError):
                m.parse_proxy(altered, NOW)

    def test_card_uses_each_current_icon_and_expiry(self):
        snap = m.parse_source(HTML, NOW)
        buffer = io.BytesIO()
        Image.new('RGBA', (100, 100), '#4ea78a').save(buffer, 'PNG')
        icons = {i['image']: buffer.getvalue() for i in snap['items']}
        png = render_merchant_card(snap, [], icons, NOW)
        image = Image.open(io.BytesIO(png))
        self.assertEqual(image.width, 1080)
        self.assertGreater(image.height, 700)
        self.assertEqual(image.format, 'PNG')
        with self.assertRaises(ValueError):
            render_merchant_card(snap, [], {}, NOW)
        with self.assertRaises(ValueError):
            render_merchant_card(snap, [], icons, snap['end'])


class SelectionCacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_old_empty_selection_is_rechecked_without_resetting_delivery_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            state = m.State(Path(directory) / 'cache.sqlite')
            self.addCleanup(state.close)
            snapshot = m.parse_source(HTML, NOW)
            snapshot['items'][1]['name'] = '首领秘药'
            state.cache('ten-categories-v3-exact-items:' + m.fingerprint(snapshot), [])
            delivery = m.delivery_key('913546080', snapshot)
            state.claim(delivery, 'already delivered', NOW)
            state.mark(delivery, 'sent', 'existing-receipt', NOW)
            request = AsyncMock()
            session = SimpleNamespace(post=lambda *args, **kwargs: request)
            monitor = object.__new__(m.MerchantMonitor)
            monitor.state = state
            monitor.bridge = SimpleNamespace(session=session,
                _api_url=lambda: 'http://localhost/v1/qq/message', _api_token=lambda: 'test-token')
            with patch.object(m, 'read_response', AsyncMock(return_value=b'{"ok":true,"selected":[1]}')) as read:
                self.assertEqual(await monitor.select(snapshot), [1])
                self.assertEqual(await monitor.select(snapshot), [1])
                read.assert_awaited_once()
            self.assertEqual(state.get(delivery)[0:3], ('sent', 'already delivered', 'existing-receipt'))


class DeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.bot = SimpleNamespace(call_action=AsyncMock(return_value={'message_id': 42}))
        self.monitor = object.__new__(m.MerchantMonitor)
        self.monitor.group = '913546080'
        self.monitor.mentions = ['1079175957', '2584778797', '1299971625', '1846366057']
        self.monitor.state = m.State(Path(self.tmp.name) / 'state.sqlite')
        self.monitor.bridge = SimpleNamespace(session=None, _qq_platform=lambda: SimpleNamespace(bot=self.bot))
        self.monitor.select = AsyncMock(return_value=[1])
        self.snap = m.parse_source(HTML, NOW)
        self.patches = [patch.object(m, 'fetch_snapshot', AsyncMock(return_value=self.snap)),
                        patch.object(m, 'fetch_icons', AsyncMock(return_value={})),
                        patch('astrbot_plugin_longtu_bridge.merchant_card.render_merchant_card', return_value=b'PNG'),
                        patch.object(m.time, 'time', return_value=NOW)]
        for p in self.patches:
            p.start()

    async def asyncTearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.monitor.state.close()
        self.tmp.cleanup()

    async def test_single_message_contains_image_and_four_real_at_segments(self):
        self.assertEqual(await self.monitor.tick(NOW), 'sent')
        call = self.bot.call_action.call_args
        self.assertEqual(call.args, ('send_group_msg',))
        self.assertEqual(call.kwargs['group_id'], 913546080)
        segments = call.kwargs['message']
        self.assertEqual([x['data']['qq'] for x in segments if x['type'] == 'at'], self.monitor.mentions)
        self.assertEqual(len([x for x in segments if x['type'] == 'image']), 1)
        self.assertEqual(await self.monitor.tick(NOW), 'already-sent')
        # Independent connection simulates reload/another worker.
        other = m.State(Path(self.tmp.name) / 'state.sqlite')
        self.assertFalse(other.claim(m.delivery_key('913546080', self.snap), 'again', NOW))
        other.close()
        self.assertEqual(self.bot.call_action.call_count, 1)

    async def test_no_targets_or_missing_image_never_mentions_anyone(self):
        self.monitor.select.return_value = []
        self.assertEqual(await self.monitor.tick(NOW), 'no-subscribed-goods')
        self.bot.call_action.assert_not_called()
        self.monitor.select.return_value = [1]
        m.fetch_icons.side_effect = ValueError('missing icon')
        with self.assertRaises(ValueError):
            await self.monitor.tick(NOW)
        self.bot.call_action.assert_not_called()

    async def test_uncertain_send_is_recovered_from_own_history_without_resend(self):
        self.bot.call_action.side_effect = asyncio.TimeoutError()
        with self.assertRaises(asyncio.TimeoutError):
            await self.monitor.tick(NOW)
        row = self.monitor.state.get(m.delivery_key(self.monitor.group, self.snap))
        self.assertEqual(row[0], 'uncertain')
        self.bot.call_action.side_effect = [dict(user_id='bot'), {'messages': [
            {'sender': {'user_id': 'bot'}, 'message_id': 91, 'message': [{'type': 'text', 'data': {'text': row[1]}}]}]}]
        self.assertEqual(await self.monitor.tick(NOW + 40), 'receipt-recovered')
        self.assertEqual(await self.monitor.tick(NOW + 50), 'already-sent')

    async def test_definite_rejection_can_retry_but_expired_round_cannot_send(self):
        self.bot.call_action.return_value = {'retcode': 100, 'status': 'failed'}
        with self.assertRaises(RuntimeError):
            await self.monitor.tick(NOW)
        self.bot.call_action.return_value = {'message_id': 71}
        self.assertEqual(await self.monitor.tick(NOW + 20), 'sent')


if __name__ == '__main__':
    unittest.main()
