"""Media result reactions land on the share-link message in every chat."""
import ast
import logging
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

main_path = Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/main.py'
source = ast.parse(main_path.read_text())
bridge = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
wanted = ('_media_group_enabled', '_media_result_emoji_id', '_react_media_result')
methods = [n for n in bridge.body if getattr(n, 'name', '') in wanted]
constants = [
    n for n in source.body
    if isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '').startswith('MEDIA_')
    and getattr(n.targets[0], 'id', '').endswith('_EMOJI_ID')
]
namespace = {'os': os, 'AstrMessageEvent': object, 'logger': logging.getLogger('test')}
module = ast.Module(
    body=[*constants, ast.ClassDef(name='Bridge', bases=[], keywords=[], body=methods, decorator_list=[])],
    type_ignores=[],
)
exec(compile(ast.fix_missing_locations(module), '<bridge-reaction>', 'exec'), namespace)
Bridge = namespace['Bridge']


def bridge_instance():
    instance = Bridge()
    instance.config = {}
    return instance


def event_for(private=False, group='361522110', sender='1079175957', message_id='9001'):
    calls = []

    async def call_action(action, **kwargs):
        calls.append((action, kwargs))
        return {}

    event = SimpleNamespace(
        bot=SimpleNamespace(call_action=call_action),
        is_private_chat=lambda: private,
        get_group_id=lambda: group,
        get_sender_id=lambda: sender,
        message_obj=SimpleNamespace(message_id=message_id),
    )
    return event, calls


class ResultReactionTests(unittest.IsolatedAsyncioTestCase):
    async def test_success_reacts_to_the_share_message(self):
        event, calls = event_for(private=True)
        self.assertTrue(await bridge_instance()._react_media_result(event, True))
        action, kwargs = calls[-1]
        self.assertEqual(action, 'set_msg_emoji_like')
        self.assertEqual(kwargs['message_id'], 9001)
        self.assertEqual(kwargs['emoji_id'], '478')
        self.assertIs(kwargs['set'], True)

    async def test_failure_reacts_to_the_same_share_message(self):
        event, calls = event_for(private=True)
        self.assertTrue(await bridge_instance()._react_media_result(event, False))
        self.assertEqual(calls[-1][1]['message_id'], 9001)
        self.assertEqual(calls[-1][1]['emoji_id'], '479')

    async def test_any_sender_and_any_group_gets_reactions(self):
        """回应不绑定某个人：换 QQ 号、换群、私聊都要挂上。"""
        cases = (
            {'private': True, 'sender': '1079175957'},
            {'private': True, 'sender': '888000111'},
            {'private': False, 'sender': '888000111', 'group': '361522110'},
            {'private': False, 'sender': '5550001', 'group': '1109147947'},
        )
        for case in cases:
            event, calls = event_for(**case)
            self.assertTrue(await bridge_instance()._react_media_result(event, True), case)
            self.assertEqual(calls[-1][1]['emoji_id'], '478', case)

    async def test_excluded_groups_get_no_result_reaction(self):
        with patch.dict(os.environ, {'QQ_MEDIA_EXCLUDED_GROUPS': '821259340,239375116'}):
            for group in ('821259340', '239375116'):
                event, calls = event_for(group=group)
                self.assertFalse(await bridge_instance()._react_media_result(event, True))
                self.assertEqual(calls, [])
            event, calls = event_for(group='1109147947')
            self.assertTrue(await bridge_instance()._react_media_result(event, False))
            self.assertEqual(calls[-1][1]['emoji_id'], '479')

    async def test_emoji_ids_are_configurable(self):
        with patch.dict(os.environ, {
            'QQ_MEDIA_SUCCESS_EMOJI_ID': '76', 'QQ_MEDIA_FAILURE_EMOJI_ID': '77',
        }):
            event, calls = event_for(private=True)
            await bridge_instance()._react_media_result(event, True)
            self.assertEqual(calls[-1][1]['emoji_id'], '76')
            event, calls = event_for(private=True)
            await bridge_instance()._react_media_result(event, False)
            self.assertEqual(calls[-1][1]['emoji_id'], '77')

    async def test_missing_message_id_never_calls_the_api(self):
        event, calls = event_for(private=True, message_id='')
        self.assertFalse(await bridge_instance()._react_media_result(event, True))
        self.assertEqual(calls, [])

    async def test_non_numeric_message_id_is_passed_through(self):
        event, calls = event_for(private=True, message_id='abc-123')
        self.assertTrue(await bridge_instance()._react_media_result(event, True))
        self.assertEqual(calls[-1][1]['message_id'], 'abc-123')


if __name__ == '__main__':
    unittest.main()
