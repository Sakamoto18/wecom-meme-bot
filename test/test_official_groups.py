"""Official report names; no AstrBot installation or live network required."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from astrbot_plugin_longtu_bridge import official_groups as groups
from astrbot_plugin_longtu_bridge.usage_report_card import report_rows

KEY = 'qqofficial:1903660238:group:verified-group-openid'


class GroupNameTests(unittest.IsolatedAsyncioTestCase):
    def bridge(self):
        return SimpleNamespace(config={'official_trial_appid': '1903660238',
            'official_trial_group_bindings': {}}, _group_names=AsyncMock(return_value={}),
            context=SimpleNamespace(platform_manager=SimpleNamespace(platform_insts=[
                SimpleNamespace(appid='1903660238', meta=lambda: SimpleNamespace(name='qq_official'))])))

    async def test_unbound_official_group_uses_api_name_in_report_without_creating_binding(self):
        bridge = self.bridge()
        result = {'group_openid': 'verified-group-openid', 'group_name': ' 实际群名 '}
        with patch.object(groups, 'request_group_info', AsyncMock(return_value=result)) as request:
            names = await groups.official_group_names(bridge, [KEY, '913546080'])
            self.assertEqual(names, {KEY: '实际群名'})
            self.assertEqual(await groups.official_group_names(bridge, [KEY]), names)
            request.assert_awaited_once_with(bridge.context.platform_manager.platform_insts[0], 'verified-group-openid')
        self.assertEqual(bridge.config['official_trial_group_bindings'], {})
        bridge._group_names.assert_not_awaited()
        self.assertEqual(report_rows({'groups': [{'groupId': KEY}]}, names)[0]['label'], '实际群名')

    async def test_permission_failure_uses_verified_qq_live_name_then_configured_name(self):
        bridge = self.bridge()
        bridge.config['official_trial_group_bindings'] = {'verified-group-openid': {
            'qq_group_id': '913546080', 'name': '已核验群名'}}
        bridge._group_names.return_value = {'913546080': '最新群名'}
        with patch.object(groups, 'request_group_info', AsyncMock(side_effect=PermissionError('11253'))) as request:
            self.assertEqual(await groups.official_group_names(bridge, [KEY]), {KEY: '最新群名'})
            bridge._group_names.assert_awaited_once_with(['913546080'])
            bridge._group_names.return_value = {}
            self.assertEqual(await groups.official_group_names(bridge, [KEY]), {KEY: '已核验群名'})
            request.assert_awaited_once()

    async def test_wrong_group_or_malformed_response_never_assigns_another_groups_name(self):
        for result in [{'group_openid': 'another-group', 'group_name': '错误群名'},
                       {'group_name': '未核验'}, None, {'group_openid': 'verified-group-openid', 'group_name': []}]:
            with patch.object(groups, 'request_group_info', AsyncMock(return_value=result)):
                self.assertEqual(await groups.official_group_names(self.bridge(), [KEY]), {KEY: '官方 QQ 群'})

    async def test_cache_refreshes_group_rename_and_other_apps_are_ignored(self):
        bridge = self.bridge()
        result = {'group_openid': 'verified-group-openid', 'group_name': '改名前'}
        with patch.object(groups, 'request_group_info', AsyncMock(return_value=result)) as request, \
                patch.object(groups, 'time', SimpleNamespace(monotonic=lambda: 10)) as clock:
            self.assertEqual(await groups.official_group_names(bridge, [KEY]), {KEY: '改名前'})
            result['group_name'] = '改名后'
            clock.monotonic = lambda: 311
            self.assertEqual(await groups.official_group_names(bridge, [KEY]), {KEY: '改名后'})
            self.assertEqual(await groups.official_group_names(bridge, [KEY.replace('1903660238', 'another-app')]), {})
            self.assertEqual(request.await_count, 2)

    async def test_cancellation_propagates(self):
        with patch.object(groups, 'request_group_info', AsyncMock(side_effect=asyncio.CancelledError())):
            with self.assertRaises(asyncio.CancelledError):
                await groups.official_group_names(self.bridge(), [KEY])

    async def test_no_official_platform_retains_existing_verified_mapping_behavior(self):
        bridge = self.bridge()
        bridge.context.platform_manager.platform_insts = []
        bridge.config['official_trial_group_bindings'] = {'verified-group-openid': {'qq_group_id': '913546080'}}
        bridge._group_names.return_value = {'913546080': '普通入口实时群名'}
        self.assertEqual(await groups.official_group_names(bridge, [KEY]), {KEY: '普通入口实时群名'})
        bridge._group_names.return_value = {}
        self.assertEqual(await groups.official_group_names(bridge, [KEY]), {KEY: 'QQ群 913546080'})
