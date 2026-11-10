import ast
import asyncio
import base64
import io
import logging
import sys
import unittest
from datetime import datetime, timedelta, time as datetime_time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from zoneinfo import ZoneInfo
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from astrbot_plugin_longtu_bridge.usage_report_card import exa_key_lines, render_usage_report, report_rows, parts, total


def sample():
    groups = [dict(groupId=str(913546080 + i), estimatedCostCny=1.8 / (i + 1),
                   uncachedInputCostCny=1 / (i + 1), cachedInputCostCny=.2 / (i + 1),
                   outputCostCny=.6 / (i + 1), searchEstimatedCostCny=.4 / (i + 1),
                   inputTokens=10000, cachedInputTokens=8000, searchCalls=8, searchCacheHits=3)
              for i in range(5)]
    return dict(startAt=1792857600000, endAt=1792944000000, groups=groups,
                pricing=dict(estimatedCostCny=sum(g['estimatedCostCny'] for g in groups),
                             search=dict(searchEstimatedCostCny=sum(g['searchEstimatedCostCny'] for g in groups),
                                         searchExchangeRates=[7.2])),
                totals=dict(requests=1800, llmCalls=320, searchCalls=40, searchCacheHits=15,
                            inputTokens=50000, cachedInputTokens=40000))


class RenderTests(unittest.TestCase):
    def test_official_group_name_and_subtitle_never_expose_internal_route(self):
        key = 'qqofficial:1903660238:group:OPENID'
        report = {'groups':[{'groupId':key, 'requests':1}]}
        row = report_rows(report, {key:'真实测试群'})[0]
        self.assertEqual(row['label'], '真实测试群')
        self.assertEqual(row['displayId'], 'QQ 官方 Bot')
        row = report_rows(report, {})[0]
        self.assertEqual(row['label'], '官方 QQ 群')
        self.assertNotIn('OPENID', row['displayId'])

    def test_png_and_empty_report(self):
        for report in (sample(), {}):
            pngs = render_usage_report(report)
            self.assertEqual(len(pngs), 1)
            image = Image.open(io.BytesIO(pngs[0]))
            self.assertEqual(image.width, 1200)
            self.assertLess(image.height, 2500)
            self.assertEqual(image.format, 'PNG')

    def test_all_groups_zero_usage_and_private_are_preserved_and_paginated(self):
        report = sample()
        report['privateUsage'] = dict(searchCalls=1, searchEstimatedCostCny=.05)
        names = {str(i): '很长的群名称📸' * 12 for i in range(30)}
        rows = report_rows(report, names)
        self.assertEqual(len(rows), 36)
        self.assertEqual(rows[-1]['label'], '私聊 / 未归属群')
        for row in rows:
            self.assertAlmostEqual(sum(parts(row)), total(row))
        pngs = render_usage_report(report, names)
        self.assertEqual(len(pngs), 3)
        self.assertTrue(all(Image.open(io.BytesIO(png)).height < 2500 for png in pngs))

    def test_private_summary_does_not_create_its_own_page_at_group_boundary(self):
        for count, expected in ((0, 1), (12, 1), (24, 2)):
            report = {'privateUsage': {'searchCalls': 1, 'searchEstimatedCostCny': .05}}
            names = {str(i): f'测试群 {i}' for i in range(count)}
            pngs = render_usage_report(report, names)
            self.assertEqual(len(pngs), expected)
            # The private row still occupies real space on the final image.
            if count:
                without_private = render_usage_report({}, names)
                self.assertEqual(Image.open(io.BytesIO(pngs[-1])).height,
                                 Image.open(io.BytesIO(without_private[-1])).height + 112)


source = ast.parse((ROOT / 'astrbot_plugin_longtu_bridge/main.py').read_text())
bridge = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
methods = [n for n in bridge.body if getattr(n, 'name', '') in (
    '_send_usage_report', '_send_requested_usage_report', '_send_daily_usage_report',
    '_send_current_usage_report', '_prepare_usage_report')]
ns = dict(asyncio=asyncio, base64=base64, logger=logging.getLogger('test'),
          datetime=datetime, timedelta=timedelta, datetime_time=datetime_time,
          REPORT_TIMEZONE=ZoneInfo('Asia/Shanghai'), render_usage_report=render_usage_report,
          Comp=SimpleNamespace(Image=SimpleNamespace(fromBase64=lambda data: ('image', data)), Plain=lambda text: ('plain', text)),
          MessageChain=lambda chain: chain)
exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='Bridge', bases=[],
    keywords=[], body=methods, decorator_list=[])], type_ignores=[])), '<bridge>', 'exec'), ns)
Bridge = ns['Bridge']


def exa_sample():
    return dict(periodStartAt=1793491200000, resetAt=1796083200000, unattributedCalls=0, keys=[
        dict(number=1, label='测试key甲', budgetUsd=17.1, spentUsd=17.3, monthlyRemainingUsd=0, bonusRemainingUsd=0, remainingUsd=0, calls=2450, state='exhausted', current=True),
        dict(number=2, label='测试key乙', budgetUsd=20, spentUsd=1.23, monthlyRemainingUsd=8.77, bonusRemainingUsd=10, remainingUsd=18.77, calls=177, state='available', current=False),
        dict(number=3, label='测试key丙', budgetUsd=20, spentUsd=0, monthlyRemainingUsd=10, bonusRemainingUsd=10, remainingUsd=20, calls=0, state='available', current=False),
    ])


class ExaKeyTests(unittest.TestCase):
    def test_rows_follow_pool_order_and_move_on_after_exhaustion(self):
        rows = exa_key_lines(exa_sample())
        self.assertEqual([(r['label'], r['status'], r['remaining']) for r in rows], [
            ('测试key甲', '已用完', '$0.00 / $17.10'),
            ('测试key乙', '使用中', '$18.77 / $20.00'),
            ('测试key丙', '待用', '$20.00 / $20.00'),
        ])
        self.assertEqual(exa_key_lines({}), [])

    def test_card_adds_catchup_panel_on_last_page(self):
        report = sample()
        plain = Image.open(io.BytesIO(render_usage_report(report)[-1]))
        report['videoLearningCatchup'] = {'day': '2026-11-04', 'status': 'done', 'items': [
            {'term': '似了', 'source': 'group', 'status': 'learned', 'meaning': '死了的谐音', 'seconds': 120},
            {'term': '黑猫鼓掌', 'source': 'bilibili', 'status': 'failed', 'error': '证据不足', 'seconds': 60},
        ]}
        with_run = Image.open(io.BytesIO(render_usage_report(report)[-1]))
        self.assertEqual(with_run.height - plain.height, 84 + 2 * 34)

    def test_card_adds_key_panel_on_last_page(self):
        report = sample()
        plain = Image.open(io.BytesIO(render_usage_report(report)[-1]))
        report['exaKeys'] = exa_sample()
        with_keys = Image.open(io.BytesIO(render_usage_report(report)[-1]))
        self.assertEqual(with_keys.height - plain.height, 112 + 3 * 58)


class DeliveryTests(unittest.IsolatedAsyncioTestCase):
    def setup_bridge(self):
        b = Bridge()
        b._qq_platform = lambda: SimpleNamespace(meta=lambda: SimpleNamespace(id='qq'))
        b.context = SimpleNamespace(send_message=AsyncMock(return_value=True))
        b._group_catalog = AsyncMock(return_value={})
        b._group_names = AsyncMock(return_value={})
        b._send_usage_report_text = AsyncMock(return_value=1)
        b._format_usage_report = AsyncMock(return_value='fallback')
        b._fetch_usage_report = AsyncMock(return_value=dict(report=sample(),
            report_user_ids=['111'], admin_user_ids=['111', '839388355']))
        return b

    async def test_current_and_dated_commands_send_images_to_expected_recipients(self):
        b = self.setup_bridge()
        self.assertEqual(await b._send_current_usage_report('839388355'), 1)
        self.assertEqual(await b._send_requested_usage_report(datetime(2026, 10, 25).date(), '839388355'), 1)
        calls = b.context.send_message.call_args_list
        self.assertEqual([c.args[0] for c in calls], ['qq:FriendMessage:111', 'qq:FriendMessage:839388355'])
        for call in calls:
            self.assertEqual(call.args[1][0][0], 'image')
            Image.open(io.BytesIO(base64.b64decode(call.args[1][0][1]))).verify()
        b._send_usage_report_text.assert_not_awaited()

    async def test_permissions_precede_render_and_send(self):
        b = self.setup_bridge()
        with self.assertRaises(PermissionError):
            await b._send_requested_usage_report(datetime(2026, 10, 25).date(), 'unauthorized')
        b.context.send_message.assert_not_awaited()

    async def test_generation_failure_falls_back_and_failed_delivery_is_not_counted(self):
        b = self.setup_bridge()
        b._group_catalog.side_effect = RuntimeError('font/catalog unavailable')
        self.assertEqual(await b._send_usage_report({'report': sample()}, 'fallback', ['111']), 1)
        b._send_usage_report_text.assert_awaited_once_with('fallback', ['111'])
        b._group_catalog.side_effect = None
        b.context.send_message.return_value = False
        self.assertEqual(await b._send_usage_report({'report': sample()}, 'fallback', ['111']), 0)


    async def test_image_rejected_for_one_account_falls_back_to_text_for_that_account(self):
        b = self.setup_bridge()

        async def send(target, chain):
            if target.endswith(':222') and chain[0][0] == 'image':
                raise RuntimeError("rich media transfer failed")
            return True
        b.context.send_message.side_effect = send
        self.assertEqual(await b._send_usage_report({'report': sample()}, 'fallback text', ['111', '222']), 2)
        sent = [(c.args[0], c.args[1][0][0]) for c in b.context.send_message.call_args_list]
        self.assertIn(('qq:FriendMessage:111', 'image'), sent)
        self.assertIn(('qq:FriendMessage:222', 'plain'), sent)


if __name__ == '__main__':
    unittest.main()
