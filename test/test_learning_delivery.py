import ast
import asyncio
import logging
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

source = ast.parse((Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/main.py').read_text())
helpers = [n for n in source.body if getattr(n, 'name', '') in ('learning_delivery_message', 'catchup_report_lines')]
bridge = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
methods = [n for n in bridge.body if getattr(n, 'name', '') in ('_learning_api_url', '_deliver_learning_results')]
namespace = dict(asyncio=asyncio, logger=logging.getLogger('learning-test'))
exec(compile(ast.fix_missing_locations(ast.Module(body=[*helpers, ast.ClassDef(
    name='Bridge', bases=[], keywords=[], body=methods, decorator_list=[],
)], type_ignores=[])), '<bridge-learning>', 'exec'), namespace)
learning_delivery_message = namespace['learning_delivery_message']
catchup_report_lines = namespace['catchup_report_lines']


class FakeResponse:
    def __init__(self, status=200, body=None):
        self.status = status
        self.body = body or {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def json(self, content_type=None):
        return self.body


class LearningDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def test_group_and_private_targets_reply_to_the_original_message(self):
        action, target, message = learning_delivery_message({
            'chatType': 'group', 'groupId': '913546080', 'userId': '1', 'messageId': '123', 'text': '似了就是死了',
        })
        self.assertEqual((action, target), ('send_group_msg', {'group_id': 913546080}))
        self.assertEqual(message, [{'type': 'reply', 'data': {'id': '123'}}, {'type': 'text', 'data': {'text': '似了就是死了'}}])
        action, target, message = learning_delivery_message({'chatType': 'private', 'userId': '555', 'text': '查到了'})
        self.assertEqual((action, target, len(message)), ('send_private_msg', {'user_id': 555}, 1))
        self.assertIsNone(learning_delivery_message({'chatType': 'group', 'groupId': 'x', 'text': 'a'}))
        self.assertIsNone(learning_delivery_message({'chatType': 'private', 'userId': '1', 'text': ''}))

    def test_daily_report_sends_one_complete_image_with_text(self):
        payload = {'chatType': 'private', 'userId': '555', 'text': '每日学习报告',
                   'reportImage': True, 'imageFile': 'base64://abc'}
        action, target, message = learning_delivery_message(payload)
        self.assertEqual(action, 'send_private_msg')
        self.assertEqual([part['type'] for part in message], ['text', 'image'])
        self.assertEqual(message[1]['data']['file'], 'base64://abc')
        payload.pop('imageFile')
        self.assertIsNone(learning_delivery_message(payload))

    async def test_claimed_deliveries_are_sent_and_receipted(self):
        b = namespace['Bridge']()
        b._api_url = lambda: 'http://127.0.0.1:8787/v1/qq/message'
        b._api_token = lambda: 'token'
        bot = SimpleNamespace(call_action=AsyncMock(side_effect=[{'message_id': 9}, {'status': 'failed', 'retcode': 100}]))
        b._qq_platform = lambda: SimpleNamespace(bot=bot)
        posts = []
        session = MagicMock(closed=False)
        session.get = MagicMock(return_value=FakeResponse(body={'deliveries': [
            {'deliveryId': 'd1', 'kind': 'result', 'payload': {'chatType': 'group', 'groupId': '1', 'messageId': '5', 'text': 'a'}},
            {'deliveryId': 'd2', 'kind': 'failure', 'payload': {'chatType': 'private', 'userId': '2', 'text': 'b'}},
        ]}))
        session.post = MagicMock(side_effect=lambda url, json, headers: posts.append((url, json)) or FakeResponse())
        b.session = session
        self.assertEqual(await b._deliver_learning_results(), 1)
        self.assertEqual(session.get.call_args.args[0], 'http://127.0.0.1:8787/v1/qq/learning/deliveries')
        self.assertEqual([body for _, body in posts], [
            {'delivery_id': 'd1', 'sent': True, 'error': ''},
            {'delivery_id': 'd2', 'sent': False, 'error': 'OneBot 发送失败'},
        ])


class CatchupReportTests(unittest.TestCase):
    def test_lines_list_each_meme_with_its_source(self):
        lines = catchup_report_lines({'day': '2026-11-04', 'status': 'done', 'elapsedMs': 300000, 'items': [
            {'term': '似了', 'source': 'group', 'status': 'learned', 'meaning': '死了的谐音', 'seconds': 120},
            {'term': '黑猫鼓掌', 'source': 'bilibili', 'status': 'failed', 'error': '看完仍没确认这个梗', 'seconds': 60},
        ]})
        self.assertEqual(lines[0], '每日补课（2026-11-04）：学会 1/2 个梗，看了 3.0 分钟视频，耗时 5.0 分钟')
        self.assertEqual(lines[1:], ['· ［群聊］似了：死了的谐音', '· ［B站梗百科］黑猫鼓掌：没学会（看完仍没确认这个梗）'])

    def test_empty_failed_and_missing_runs(self):
        self.assertEqual(catchup_report_lines(None), [])
        self.assertIn('都没找到要学的新梗', catchup_report_lines({'day': '2026-11-04', 'items': []})[0])
        self.assertIn('补课失败：B 站超时', catchup_report_lines({'day': '2026-11-04', 'status': 'failed', 'error': 'B 站超时'})[0])


if __name__ == '__main__':
    unittest.main()
