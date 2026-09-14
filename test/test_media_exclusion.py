import ast
import logging
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

source = ast.parse((Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/main.py').read_text())
bridge = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
methods = [n for n in bridge.body if getattr(n, 'name', '') in ('_media_group_enabled', '_react_media_share')]
ns = {'os': os, 'AstrMessageEvent': object, 'logger': logging.getLogger('test')}
exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='Bridge', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])), '<bridge>', 'exec'), ns)

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

if __name__ == '__main__': unittest.main()
