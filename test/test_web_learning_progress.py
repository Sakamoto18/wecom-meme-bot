import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from astrbot_plugin_longtu_bridge.web_learning_progress import learning_receipt, is_learning_request

class ProgressTests(unittest.IsolatedAsyncioTestCase):
    async def test_receipt_only_for_explicit_request_not_progress_or_passive(self):
        event = SimpleNamespace(is_private_chat=lambda: False, send=AsyncMock())
        payload = {'text': '/learn-meme 肥嘟嘟', 'bot_user_id': 'bot', 'mentions': [{'user_id': 'bot'}]}
        await learning_receipt(event, payload)
        event.send.assert_awaited_once()
        for text in ('/learn-status', '/learn-report', '学习进度', '普通消息'):
            await learning_receipt(event, {**payload, 'text': text})
        await learning_receipt(event, {**payload, 'observe_only': True})
        await learning_receipt(event, {**payload, 'mentions': []})
        event.send.assert_awaited_once()
        event.send.side_effect = TimeoutError()
        await learning_receipt(event, payload)
        self.assertTrue(is_learning_request('你去学习一下114514相关梗的内容和关联，发个报告到群里'))
        self.assertFalse(is_learning_request('学一下这个视频 https://b23.tv/example'))

    async def test_slow_learning_progress_stops_and_final_mentions_raw_sender(self):
        import asyncio
        from astrbot_plugin_longtu_bridge.web_learning_progress import request_learning_backend, deliver_learning_report
        event = SimpleNamespace(is_private_chat=lambda: False, get_sender_id=lambda: 'raw-openid', send=AsyncMock())
        payload = {'text': '/learn-meme 肥嘟嘟', 'bot_user_id': 'bot', 'mentions': [{'user_id': 'bot'}], 'user_id': 'bound-qq', 'message_id': 'request1'}
        result = {'learning_completed': True, 'messages': [{'type': 'image', 'base64': 'iVBOR'}]}
        async def backend(body):
            if body['text'] == '/learn-status':
                return {'learning_request_id': 'request1', 'messages': [{'text': '正在审核置信度'}]}
            await asyncio.sleep(.04)
            return result
        bridge = SimpleNamespace(_request_backend=AsyncMock(side_effect=backend))
        self.assertEqual(await request_learning_backend(bridge, event, payload, intervals=(.001, .001)), result)
        self.assertEqual(event.send.await_count, 3)
        self.assertIn('核出处', event.send.await_args_list[1].args[0].chain[0].text)
        await deliver_learning_report(event, result)
        chain = event.send.await_args.args[0].chain
        self.assertEqual(chain[0].qq, 'raw-openid')
        self.assertEqual(chain[-1].file, 'base64://iVBOR')
        await asyncio.sleep(.01)
        self.assertEqual(event.send.await_count, 4)

    async def test_fast_result_no_progress_and_private_no_at(self):
        from astrbot_plugin_longtu_bridge.web_learning_progress import request_learning_backend, deliver_learning_report
        event = SimpleNamespace(is_private_chat=lambda: True, send=AsyncMock())
        result = {'learning_completed': True, 'messages': [{'type': 'text', 'text': '学习失败，未入库'}]}
        bridge = SimpleNamespace(_request_backend=AsyncMock(return_value=result))
        await request_learning_backend(bridge, event, {'text': '/learn-meme 梗'}, intervals=(.001, .001))
        self.assertEqual(event.send.await_count, 1)
        await deliver_learning_report(event, result)
        self.assertEqual(len(event.send.await_args.args[0].chain), 1)
        self.assertFalse(await deliver_learning_report(event, {'messages': []}))

    async def test_notification_failure_does_not_cancel_learning_or_retry_report(self):
        from astrbot_plugin_longtu_bridge.web_learning_progress import request_learning_backend, deliver_learning_report
        event = SimpleNamespace(is_private_chat=lambda: True, send=AsyncMock(side_effect=TimeoutError()))
        result = {'learning_completed': True, 'messages': [{'type': 'image', 'base64': 'iVBOR'}]}
        bridge = SimpleNamespace(_request_backend=AsyncMock(return_value=result))
        self.assertEqual(await request_learning_backend(bridge, event, {'text': '/learn-meme 梗'}), result)
        self.assertTrue(await deliver_learning_report(event, result))
        self.assertEqual(event.send.await_count, 3)  # receipt, report, distinct recovery text
        self.assertIn('/learn-report', event.send.await_args.args[0].chain[0].text)
