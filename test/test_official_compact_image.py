import asyncio
import base64
import io
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from PIL import Image
from astrbot_plugin_longtu_bridge.official_compact_image import image_metadata, send_compact_image


def png(size):
    buf = io.BytesIO()
    Image.new('RGB', size).save(buf, 'PNG')
    return base64.b64encode(buf.getvalue()).decode()


class MetadataTests(unittest.TestCase):
    def test_aspect_ratio_no_upscaling_and_original_bytes(self):
        for original, expected in (((400,600),(133,200)), ((600,400),(200,133)),
                                   ((500,500),(200,200)), ((64,32),(64,32))):
            encoded = png(original)
            data, ext, mime, width, height = image_metadata(encoded)
            self.assertEqual((width,height),expected)
            self.assertEqual(data,base64.b64decode(encoded))
            self.assertEqual((ext,mime),('png','image/png'))


class SendTests(unittest.IsolatedAsyncioTestCase):
    async def test_send_uses_sized_markdown_and_cleans_material_on_success_or_unknown_send(self):
        for private in (True, False):
            for uncertain in (True, False):
                request = AsyncMock(side_effect=[{'upload_id':'up','presigned_url':'https://example/upload'},
                    {'image_id':'own-image','url':'qqbot-media://image/v1/test'},
                    asyncio.TimeoutError() if uncertain else {'id':'sent'}, {}])
                event = SimpleNamespace(bot=SimpleNamespace(api=SimpleNamespace(_http=SimpleNamespace(request=request))),
                    is_private_chat=lambda:private, get_sender_id=lambda:'user', get_group_id=lambda:'group',
                    message_obj=SimpleNamespace(message_id='incoming'))
                response = SimpleNamespace(headers={'ETag':'"etag"'}, raise_for_status=lambda:None)
                class Context:
                    async def __aenter__(self): return response
                    async def __aexit__(self,*args): pass
                class Session:
                    async def __aenter__(self): return self
                    async def __aexit__(self,*args): pass
                    def put(self,*args,**kwargs): return Context()
                with patch('astrbot_plugin_longtu_bridge.official_compact_image.aiohttp.ClientSession',return_value=Session()):
                    if uncertain:
                        with self.assertRaises(asyncio.TimeoutError): await send_compact_image(event,png((600,400)))
                    else:
                        self.assertTrue(await send_compact_image(event,png((600,400))))
                self.assertEqual(request.await_count,4)
                payload=request.call_args_list[2].kwargs['json']
                self.assertEqual(payload['msg_type'],2)
                self.assertIn('#200px #133px',payload['markdown']['content'])
                self.assertEqual(payload['msg_id'],'incoming')
                self.assertEqual(request.call_args_list[-1].args[0].method,'DELETE')

    async def test_prepare_failure_allows_normal_image_fallback_without_sending(self):
        request=AsyncMock(side_effect=RuntimeError('no permission'))
        event=SimpleNamespace(bot=SimpleNamespace(api=SimpleNamespace(_http=SimpleNamespace(request=request))))
        self.assertFalse(await send_compact_image(event,png((400,400))))
        request.assert_awaited_once()
