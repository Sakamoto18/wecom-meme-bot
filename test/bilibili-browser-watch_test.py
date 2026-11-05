import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services/douyin-provider'))
import bilibili_watch as watch
from browser_audio import transcribe_recording


class WatchTests(unittest.IsolatedAsyncioTestCase):
    def test_only_bilibili_video_pages(self):
        for url in ['https://www.bilibili.com/video/BV1Epx96EEBG', 'https://b23.tv/Ab123']:
            self.assertEqual(watch.watch_url(url), url)
        for url in ['http://www.bilibili.com/video/BV1Epx96EEBG', 'https://localhost/',
                    'https://www.bilibili.com.evil.com/video/BV1Epx96EEBG',
                    'https://user@www.bilibili.com/video/BV1Epx96EEBG',
                    'https://www.bilibili.com:443/video/BV1Epx96EEBG',
                    'https://www.bilibili.com/other']:
            with self.assertRaises(ValueError):
                watch.watch_url(url)

    def test_dynamic_duration_and_rounding_do_not_stall_at_end(self):
        self.assertTrue(watch.playback_complete({'time': 136.9, 'duration': 136.97, 'ended': False}, 137))
        self.assertTrue(watch.playback_complete({'time': 224, 'duration': 224, 'ended': True}, 300))
        self.assertFalse(watch.playback_complete({'time': 90, 'duration': 137, 'ended': False}, 137))

    async def test_navigation_failure_closes_page_and_releases_slot(self):
        page = AsyncMock()
        page.goto.side_effect = ValueError('navigation failed')
        context = AsyncMock()
        context.new_page.return_value = page
        slots = asyncio.Semaphore(1)
        previous, watch.WATCH_SLOTS = watch.WATCH_SLOTS, slots
        try:
            with self.assertRaisesRegex(ValueError, 'navigation failed'):
                await watch.watch_page(context, 'https://www.bilibili.com/video/BV1Epx96EEBG', 3, AsyncMock())
            page.close.assert_awaited_once()
            self.assertFalse(slots.locked())
        finally:
            watch.WATCH_SLOTS = previous

    async def test_no_audio_is_explicit_and_does_not_transcribe(self):
        page = AsyncMock()
        result = await transcribe_recording(page, {'ok': False})
        self.assertEqual(result['status'], 'unavailable')
        self.assertIn('本次未学习音频', result['error'])
        page.evaluate.assert_not_awaited()

    async def test_audio_failure_is_nonfatal(self):
        page = AsyncMock()
        page.evaluate.side_effect = ValueError('audio unavailable')
        result = await transcribe_recording(page, {'ok': True})
        self.assertEqual(result['status'], 'unavailable')
        self.assertIn('本次未学习音频', result['error'])


if __name__ == '__main__':
    unittest.main()
