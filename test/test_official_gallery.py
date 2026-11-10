import asyncio
import base64
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from astrbot_plugin_longtu_bridge.official_gallery import send_gallery, GalleryPreparationError


class GalleryTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, count=18):
        event = SimpleNamespace(bot=SimpleNamespace(api=SimpleNamespace(_http=object())))
        bridge = SimpleNamespace(_cover_bytes=AsyncMock(side_effect=lambda url, *a, **k: url.encode()))
        gallery = {'title': '[title](https://example)', 'description': '描述',
                   'images': [f'https://example/{i}' for i in range(count)]}
        return event, bridge, gallery

    async def test_all_originals_and_card_in_one_send_without_truncation(self):
        event, bridge, gallery = self.fixture()
        uploaded = []
        async def upload(http, encoded, ids, max_edge):
            uploaded.append(base64.b64decode(encoded))
            ids.append(str(len(uploaded)))
            return f'qqbot-media://image/v1/{len(uploaded)}', 480, 320
        with patch('astrbot_plugin_longtu_bridge.official_gallery.upload_markdown_image', side_effect=upload), \
             patch('astrbot_plugin_longtu_bridge.official_gallery.send_markdown_images', new_callable=AsyncMock) as send, \
             patch('astrbot_plugin_longtu_bridge.official_gallery.cleanup_materials', new_callable=AsyncMock) as cleanup:
            await send_gallery(event, bridge, [gallery], base64.b64encode(b'card').decode())
        self.assertEqual(uploaded, [b'card'] + [s.encode() for s in gallery['images']])
        send.assert_awaited_once()
        content = send.call_args.args[1]
        self.assertEqual(content.count('qqbot-media://'), 19)
        self.assertLess(content.index('原图1 '), content.index('原图18 '))
        self.assertEqual(len(cleanup.call_args.args[1]), 19)

    async def test_no_card_keeps_escaped_description_and_one_message(self):
        event, bridge, gallery = self.fixture(2)
        with patch('astrbot_plugin_longtu_bridge.official_gallery.upload_markdown_image',
                   new_callable=AsyncMock, return_value=('qqbot-media://image/v1/x', 300, 400)), \
             patch('astrbot_plugin_longtu_bridge.official_gallery.send_markdown_images', new_callable=AsyncMock) as send, \
             patch('astrbot_plugin_longtu_bridge.official_gallery.cleanup_materials', new_callable=AsyncMock):
            await send_gallery(event, bridge, [gallery])
        content = send.call_args.args[1]
        self.assertIn('描述', content)
        self.assertNotIn('[title](https://example)', content)
        self.assertEqual(content.count('![原图'), 2)

    async def test_partial_preparation_failure_cleans_up_and_sends_nothing(self):
        event, bridge, gallery = self.fixture(2)
        async def upload(http, encoded, ids, max_edge):
            if ids:
                raise RuntimeError('upload denied')
            ids.append('first')
            return 'qqbot-media://image/v1/first', 200, 300
        with patch('astrbot_plugin_longtu_bridge.official_gallery.upload_markdown_image', side_effect=upload), \
             patch('astrbot_plugin_longtu_bridge.official_gallery.send_markdown_images', new_callable=AsyncMock) as send, \
             patch('astrbot_plugin_longtu_bridge.official_gallery.cleanup_materials', new_callable=AsyncMock) as cleanup:
            with self.assertRaises(GalleryPreparationError):
                await send_gallery(event, bridge, [gallery])
        send.assert_not_awaited()
        self.assertEqual(cleanup.call_args.args[1], ['first'])

    async def test_uncertain_send_is_not_retried_and_cleans_up(self):
        event, bridge, gallery = self.fixture(2)
        with patch('astrbot_plugin_longtu_bridge.official_gallery.upload_markdown_image',
                   new_callable=AsyncMock, return_value=('qqbot-media://image/v1/x', 300, 400)), \
             patch('astrbot_plugin_longtu_bridge.official_gallery.send_markdown_images',
                   new_callable=AsyncMock, side_effect=asyncio.TimeoutError()) as send, \
             patch('astrbot_plugin_longtu_bridge.official_gallery.cleanup_materials', new_callable=AsyncMock) as cleanup:
            with self.assertRaises(asyncio.TimeoutError):
                await send_gallery(event, bridge, [gallery])
        send.assert_awaited_once()
        cleanup.assert_awaited_once()
