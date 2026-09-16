import ast
import logging
import os
import re
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

source = ast.parse((Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/main.py').read_text())
bridge = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
wanted = ('_media_group_enabled', '_react_media_share',
          '_group_allowed_providers', '_providers_in_text')
methods = [n for n in bridge.body if getattr(n, 'name', '') in wanted]
patterns = [n for n in source.body if isinstance(n, ast.Assign)
            and getattr(n.targets[0], 'id', '') == 'MEDIA_PROVIDER_PATTERNS']
ns = {'os': os, 're': re, 'AstrMessageEvent': object, 'logger': logging.getLogger('test')}
exec(compile(ast.fix_missing_locations(ast.Module(body=[*patterns, ast.ClassDef(name='Bridge', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])), '<bridge>', 'exec'), ns)

class ExclusionTests(unittest.IsolatedAsyncioTestCase):
    async def test_excluded_groups_never_call_reaction_api(self):
        instance = ns['Bridge'](); instance.config = {}
        calls = []
        async def call_action(*args, **kwargs): calls.append((args, kwargs))
        with patch.dict(os.environ, {'QQ_MEDIA_EXCLUDED_GROUPS':'821259340,239375116'}):
            for group in ('821259340', '239375116', '1109147947'):
                event = SimpleNamespace(is_private_chat=lambda:False, get_group_id=lambda:group,
                    message_obj=SimpleNamespace(message_id='123'), bot=SimpleNamespace(call_action=call_action))
                self.assertEqual(await instance._react_media_share(event), group == '1109147947')
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], ('set_msg_emoji_like',))

DOUYIN = 'https://v.douyin.com/abc123/'
BILIBILI = 'https://b23.tv/abc'
XHS = 'https://xhslink.com/a/abc'


class ProviderWhitelistTests(unittest.TestCase):
    """白名单群只放行指定平台，其余平台保持关闭。"""

    WHITELIST = '821259340:douyin,239375116:douyin'

    def bridge(self):
        instance = ns['Bridge']()
        instance.config = {}
        return instance

    def event(self, group):
        return SimpleNamespace(is_private_chat=lambda: False, get_group_id=lambda: group)

    def test_whitelisted_groups_allow_only_douyin(self):
        env = {'QQ_MEDIA_GROUP_ALLOWED_PROVIDERS': self.WHITELIST,
               'QQ_MEDIA_EXCLUDED_GROUPS': '821259340,239375116'}
        with patch.dict(os.environ, env):
            instance = self.bridge()
            for group in ('821259340', '239375116'):
                event = self.event(group)
                # 抖音放行，即使这两个群还留在整群排除名单里。
                self.assertTrue(instance._media_group_enabled(event, DOUYIN), group)
                # 其余平台仍然关闭。
                self.assertFalse(instance._media_group_enabled(event, BILIBILI), group)
                self.assertFalse(instance._media_group_enabled(event, XHS), group)
                self.assertFalse(
                    instance._media_group_enabled(event, 'https://example.com/x'), group,
                )

    def test_mixed_message_passes_when_it_carries_an_allowed_link(self):
        with patch.dict(os.environ, {'QQ_MEDIA_GROUP_ALLOWED_PROVIDERS': self.WHITELIST}):
            instance = self.bridge()
            text = f'看这个 {BILIBILI} 还有 {DOUYIN}'
            self.assertTrue(instance._media_group_enabled(self.event('821259340'), text))

    def test_other_groups_keep_using_the_group_level_switch(self):
        env = {'QQ_MEDIA_GROUP_ALLOWED_PROVIDERS': self.WHITELIST,
               'QQ_MEDIA_EXCLUDED_GROUPS': '821259340,239375116,999888777'}
        with patch.dict(os.environ, env):
            instance = self.bridge()
            # 不在白名单里的群：排除名单照旧全平台关闭。
            self.assertFalse(instance._media_group_enabled(self.event('999888777'), DOUYIN))
            # 既不在白名单也不在排除名单：全平台开放。
            self.assertTrue(instance._media_group_enabled(self.event('1109147947'), BILIBILI))

    def test_private_chat_is_never_restricted(self):
        with patch.dict(os.environ, {'QQ_MEDIA_GROUP_ALLOWED_PROVIDERS': self.WHITELIST}):
            private = SimpleNamespace(is_private_chat=lambda: True, get_group_id=lambda: '')
            self.assertTrue(self.bridge()._media_group_enabled(private, BILIBILI))

    def test_provider_detection_matches_each_platform(self):
        instance = self.bridge()
        self.assertEqual(instance._providers_in_text(DOUYIN), {'douyin'})
        self.assertEqual(instance._providers_in_text(BILIBILI), {'bilibili'})
        self.assertEqual(instance._providers_in_text(XHS), {'xiaohongshu'})
        self.assertEqual(instance._providers_in_text('https://www.kuaishou.com/f/x'), {'kuaishou'})
        self.assertEqual(instance._providers_in_text('没有链接'), set())
        self.assertEqual(
            instance._providers_in_text(f'{DOUYIN} {BILIBILI}'), {'douyin', 'bilibili'},
        )

    def test_malformed_whitelist_falls_back_to_group_switch(self):
        env = {'QQ_MEDIA_GROUP_ALLOWED_PROVIDERS': '821259340:',
               'QQ_MEDIA_EXCLUDED_GROUPS': '821259340'}
        with patch.dict(os.environ, env):
            # 平台列表为空视为没配置，回到整群开关（此处仍是关闭）。
            self.assertFalse(self.bridge()._media_group_enabled(self.event('821259340'), DOUYIN))

if __name__ == '__main__': unittest.main()
