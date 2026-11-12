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
