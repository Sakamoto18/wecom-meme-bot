"""Official merchant material lifecycle, using the real AstrBot environment."""
import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from astrbot_plugin_longtu_bridge import merchant_official as merchant
from astrbot_plugin_longtu_bridge import official_compact_image as images


class MaterialTests(unittest.IsolatedAsyncioTestCase):
    async def test_preparation_keeps_full_stock_card_and_cleans_every_exit(self):
        http = object()
        client = SimpleNamespace(api=SimpleNamespace(_http=http))
        for failure in (None, RuntimeError('no receipt'), asyncio.CancelledError()):
            async def upload(http_arg, encoded, material_ids, max_edge):
                self.assertIs(http_arg, http)
                self.assertEqual(encoded, 'UE5H')
                self.assertEqual(max_edge, 1080)
                material_ids.append('own-material')
                return 'qqbot-media://image/v1/stock', 1080, 900
            with patch.object(images, 'upload_markdown_image', side_effect=upload), \
                 patch.object(images, 'cleanup_materials', AsyncMock()) as cleanup:
                async def use():
                    async with merchant.prepare_mention_image(client, b'PNG') as media:
                        self.assertEqual(media, merchant.MentionImage('qqbot-media://image/v1/stock', 1080, 900))
                        cleanup.assert_not_awaited()
                        if failure:
                            raise failure
                if failure:
                    with self.assertRaises(type(failure)):
                        await use()
                else:
                    await use()
                cleanup.assert_awaited_once_with(http, ['own-material'])

    async def test_upload_failure_after_material_created_cleans_without_entering(self):
        http = object()
        client = SimpleNamespace(api=SimpleNamespace(_http=http))
        async def upload(http_arg, encoded, material_ids, max_edge):
            material_ids.append('invalid-material')
            raise ValueError('Invalid official image reference')
        with patch.object(images, 'upload_markdown_image', side_effect=upload), \
             patch.object(images, 'cleanup_materials', AsyncMock()) as cleanup:
            with self.assertRaises(ValueError):
                async with merchant.prepare_mention_image(client, b'PNG'):
                    self.fail('An invalid upload must not reach the delivery claim')
            cleanup.assert_awaited_once_with(http, ['invalid-material'])
