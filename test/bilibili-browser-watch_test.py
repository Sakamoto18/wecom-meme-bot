import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

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

    def test_ended_event_survives_auto_replay_but_mid_video_rewind_is_not_success(self):
        state = {'time': 26, 'duration': 133, 'ended': False,
                 'completion': {'time': 132.9, 'duration': 133}}
        self.assertEqual(watch.completed_time(state, 133, 132), 132.9)
        self.assertIsNone(watch.completed_time(state, 133, 60))
        state['completion'] = None
        self.assertIsNone(watch.completed_time(state, 133, 132))

    async def test_screenshot_retries_render_failure_without_font_wait(self):
        page = Mock(is_closed=Mock(return_value=False), bring_to_front=AsyncMock())
        session = Mock(send=AsyncMock(side_effect=[TimeoutError(), {'data': 'pixels'}]))
        box = {'x': 0, 'y': 0, 'width': 640, 'height': 360}
        self.assertEqual(await watch.screenshot_frame(page, session, box), 'pixels')
        self.assertEqual(session.send.await_count, 2)
        self.assertEqual(session.send.call_args.args[0], 'Page.captureScreenshot')
        self.assertEqual(session.send.call_args.args[1]['clip']['scale'], 1)
        session.send.side_effect = TimeoutError()
        with self.assertRaisesRegex(ValueError, '截图阶段失败'):
            await watch.screenshot_frame(page, session, box)

    async def test_disconnect_cancels_operation_and_releases_slot_even_during_asr(self):
        entered, cancelled = asyncio.Event(), asyncio.Event()
        async def operation(*args):
            async with watch.WATCH_SLOTS:
                entered.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()
        async def disconnected():
            await entered.wait()
            return True
        with patch.object(watch, '_watch_page', operation):
            with self.assertRaisesRegex(ValueError, '请求已断开'):
                await watch.watch_page(None, 'url', 3, disconnected)
        self.assertTrue(cancelled.is_set())
        self.assertFalse(watch.WATCH_SLOTS.locked())

    async def test_queue_busy_is_distinct_from_watching_failure(self):
        slots = asyncio.Semaphore(0)
        with patch.object(watch, 'WATCH_SLOTS', slots), patch.object(watch, 'QUEUE_SECONDS', 0.01):
            with self.assertRaisesRegex(watch.WatchBusyError, '尚未开始观看'):
                await watch.watch_page(None, 'https://www.bilibili.com/video/BV1Epx96EEBG', 3, AsyncMock(return_value=False))
        self.assertTrue(slots.locked())

    async def test_navigation_failure_closes_page_and_releases_slot(self):
        page = AsyncMock()
        page.goto.side_effect = ValueError('navigation failed')
        context = AsyncMock()
        context.new_page.return_value = page
        slots = asyncio.Semaphore(1)
        previous, watch.WATCH_SLOTS = watch.WATCH_SLOTS, slots
        try:
            with self.assertRaisesRegex(ValueError, 'navigation failed'):
                await watch.watch_page(context, 'https://www.bilibili.com/video/BV1Epx96EEBG', 3, AsyncMock(return_value=False))
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
