"""Full-duration compression, cache sharing and preparation failure checks."""
import asyncio
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from astrbot_plugin_longtu_bridge import official_video as v


class OfficialVideoTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name)

    async def asyncTearDown(self):
        self.tmp.cleanup()

    async def test_compression_uses_two_passes_and_keeps_audio_and_full_duration(self):
        source, output = self.directory / 'source.mp4', self.directory / 'output.mp4'
        calls = []
        async def run(args, timeout):
            calls.append(list(map(str, args)))
            if str(args[-1]) == str(output):
                output.write_bytes(b'compressed')
        with patch.object(v, 'run_tool', AsyncMock(side_effect=run)), \
             patch.object(v, 'probe', AsyncMock(return_value=(3600, True))):
            self.assertEqual(await v.compress_video(source, output, ffmpeg='ffmpeg'), 10)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][calls[0].index('-pass') + 1], '1')
        self.assertEqual(calls[1][calls[1].index('-pass') + 1], '2')
        self.assertIn('0:a:0?', calls[1])
        for args in calls:
            for forbidden in ('-fs', '-t', '-ss', 'segment'):
                self.assertNotIn(forbidden, args)

    async def test_invalid_duration_missing_audio_and_oversize_output_are_rejected(self):
        for duration, audio, size in ((2500, True, 20), (3600, False, 20), (3600, True, 101)):
            with self.subTest(duration=duration, audio=audio, size=size):
                source, output = self.directory / 'source.mp4', self.directory / 'output.mp4'
                async def run(args, timeout):
                    if args[-1] == output: output.write_bytes(b'x' * size)
                with patch.object(v, 'run_tool', AsyncMock(side_effect=run)), \
                     patch.object(v, 'encoding_budget', return_value=(1000, 100, 640, 360)), \
                     patch.object(v, 'probe', AsyncMock(side_effect=[(3600, True), (duration, audio)])):
                    with self.assertRaises(v.OfficialVideoPreparationError):
                        await v.compress_video(source, output, ffmpeg='ffmpeg', maximum=100)

    async def test_cross_group_concurrency_downloads_and_compresses_once(self):
        cache = v.OfficialVideoCache(self.directory)
        async def download(url, path):
            await asyncio.sleep(0.01)
            path.write_bytes(b'original-video')
            return v.MAX_BYTES + 1
        async def compress(source, output, **kwargs):
            await asyncio.sleep(0.01)
            output.write_bytes(b'compressed')
        async def prepare():
            async with cache.prepare('https://internal/same-video', ffmpeg='ffmpeg') as prepared:
                self.assertTrue(prepared.path.is_file())
                self.assertEqual(prepared.size, 10)
                await asyncio.sleep(0.01)
                return prepared.path
        cache.download = AsyncMock(side_effect=download)
        with patch.object(v, 'compress_video', AsyncMock(side_effect=compress)) as encode:
            first, second = await asyncio.gather(prepare(), prepare())
        self.assertEqual(first, second)
        cache.download.assert_awaited_once()
        encode.assert_awaited_once()

    async def test_small_video_not_reencoded_and_active_file_not_evicted(self):
        cache = v.OfficialVideoCache(self.directory, max_cache_bytes=1)
        async def download(url, path):
            path.write_bytes(b'original')
            return 8
        cache.download = AsyncMock(side_effect=download)
        with patch.object(v, 'compress_video', AsyncMock()) as encode:
            async with cache.prepare('https://internal/small', ffmpeg='ffmpeg') as prepared:
                cache.prune()
                self.assertEqual(prepared.path.read_bytes(), b'original')
                self.assertEqual(prepared.original_size, 8)
            self.assertFalse(prepared.path.exists())
            encode.assert_not_awaited()

    async def test_failed_compression_not_cached_and_retry_starts_clean(self):
        cache = v.OfficialVideoCache(self.directory)
        async def download(url, path):
            path.write_bytes(b'original')
            return v.MAX_BYTES + 1
        cache.download = AsyncMock(side_effect=download)
        with patch.object(v, 'compress_video', AsyncMock(side_effect=asyncio.TimeoutError())):
            with self.assertRaisesRegex(v.OfficialVideoPreparationError, '超时'):
                async with cache.prepare('https://internal/large', ffmpeg='ffmpeg'):
                    self.fail('must not send failed output')
        self.assertEqual(cache.entries, {})
        self.assertEqual(list(self.directory.iterdir()), [])

    async def test_windows_cleanup_error_does_not_mask_successful_upload(self):
        cache = v.OfficialVideoCache(self.directory, max_cache_bytes=1)
        async def download(url, path):
            path.write_bytes(b'original')
            return 8
        cache.download = AsyncMock(side_effect=download)
        lease = cache.prepare('https://internal/locked', ffmpeg='ffmpeg')
        prepared = await lease.__aenter__()
        with patch.object(Path, 'unlink', side_effect=PermissionError('busy')) as unlink:
            await lease.__aexit__(None, None, None)
            unlink.assert_called_once()
        self.assertTrue(prepared.path.exists())
        # Cleanup can complete later, after the upload handle is released.
        cache.prune()
        self.assertFalse(prepared.path.exists())

    async def test_transcoder_timeout_kills_and_reaps_before_temp_cleanup(self):
        process = AsyncMock()
        process.returncode = None
        process.kill = unittest.mock.Mock()
        process.communicate.side_effect = [asyncio.TimeoutError(), (b'', b'')]
        with patch('asyncio.create_subprocess_exec', AsyncMock(return_value=process)):
            with self.assertRaises(asyncio.TimeoutError):
                await v.run_tool(['ffmpeg'], 1)
        process.kill.assert_called_once()
        self.assertEqual(process.communicate.await_count, 2)

    def test_invalid_bitrate_budget_rejects_unusable_compression(self):
        with self.assertRaises(v.OfficialVideoPreparationError):
            v.encoding_budget(100000, True, 1000)
