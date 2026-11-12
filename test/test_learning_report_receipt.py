import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
import astrbot.api.message_components as Comp
from astrbot.api.event import MessageChain
from astrbot_plugin_longtu_bridge.learning_report_receipt import send_with_receipt, remember_receipt, flush_receipts, connect

class ReceiptTests(unittest.IsolatedAsyncioTestCase):
    async def test_onebot_send_once_and_read_actual_id(self):
        event = SimpleNamespace(get_platform_name=lambda: 'aiocqhttp', is_private_chat=lambda: False,
            get_group_id=lambda: '123', get_sender_id=lambda: '456',
            bot=SimpleNamespace(call_action=AsyncMock(return_value={'message_id': 789})), send=AsyncMock())
        result = await send_with_receipt(event, MessageChain([Comp.At(qq='456'), Comp.Image(file='base64://abc')]))
        self.assertEqual(result, '789');event.bot.call_action.assert_awaited_once();event.send.assert_not_awaited()
        self.assertEqual(event.bot.call_action.call_args.kwargs['group_id'], 123)
        event.bot.call_action.return_value = {'status': 'failed', 'retcode': 1200}
        with self.assertRaises(RuntimeError):await send_with_receipt(event, MessageChain([Comp.Plain('x')]))

    async def test_official_underlying_receipt_uses_inbound_namespace(self):
        event = SimpleNamespace(get_platform_name=lambda: 'qq_official', get_self_id=lambda: 'bot',
            bot=SimpleNamespace(platform=SimpleNamespace(appid='1903660238')),
            _post_send=AsyncMock(return_value=SimpleNamespace(id='platform-msg')), send=AsyncMock())
        chain = MessageChain([Comp.Image(file='base64://abc')])
        self.assertEqual(await send_with_receipt(event, chain), 'qqofficial:1903660238:message:platform-msg')
        self.assertIs(event.send_buffer, chain);event._post_send.assert_awaited_once();event.send.assert_not_awaited()
        event._post_send.return_value = None
        self.assertEqual(await send_with_receipt(event, chain), '')

    async def test_failed_ack_is_durable_and_replayed_without_resending_message(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory)/'outbox.sqlite')
            bridge = SimpleNamespace(_learning_receipt_db=path, session=None)
            await remember_receipt(bridge, 'token', 'id')
            with connect(bridge) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM receipts').fetchone()[0], 1)
            class Response:
                status = 200
                async def __aenter__(self):return self
                async def __aexit__(self,*args):pass
                async def json(self,**kwargs):return {'ok':True}
            class Session:
                def post(self,url,**kwargs):
                    self.body = kwargs['json'];return Response()
            restored = SimpleNamespace(_learning_receipt_db=path, session=Session(),
                _api_url=lambda:'http://backend/v1/qq/message',_api_token=lambda:'test')
            await flush_receipts(restored)
            self.assertEqual(restored.session.body, {'token':'token','message_id':'id'})
            with connect(restored) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM receipts').fetchone()[0], 0)
