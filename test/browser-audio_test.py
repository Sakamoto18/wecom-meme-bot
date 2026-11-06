import asyncio
import base64
import io
import os
import sys
import unittest
import wave
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services/douyin-provider'))
import browser_audio

class AudioTests(unittest.IsolatedAsyncioTestCase):
    async def run_asr(self, code):
        data = io.BytesIO()
        with wave.open(data, 'wb') as wav:
            wav.setparams((1, 2, 16000, 0, 'NONE', 'NONE'))
            wav.writeframes(b'\x01\x00' * 16000)
        page = AsyncMock()
        page.evaluate.return_value = base64.b64encode(data.getvalue()).decode()
        spawn = asyncio.create_subprocess_exec
        wait = asyncio.wait_for
        async def fake_spawn(*args, **kwargs):
            return await spawn(sys.executable, '-c', code, **kwargs)
        async def short_wait(awaitable, timeout):
            return await wait(awaitable, 0.3 if timeout == 120 else timeout)
        with patch.dict(os.environ, QQ_VIDEO_LEARNING_ASR_PYTHON=sys.executable), \
             patch.object(browser_audio.asyncio, 'create_subprocess_exec', fake_spawn), \
             patch.object(browser_audio.asyncio, 'wait_for', short_wait):
            return await browser_audio.transcribe_recording(page, {'ok': True})

    async def test_completed_audio(self):
        result = await self.run_asr('print(\'[ {"start":0,"end":1,"text":"hello"} ]\')')
        self.assertEqual(result['status'], 'transcribed')
        self.assertEqual(result['diagnostics']['audioSeconds'], 1)

    async def test_timeout_keeps_finished_segments_and_stops_child(self):
        result = await self.run_asr('import os,time; open(os.environ["ASR_PROGRESS_PATH"],"w").write(\'{"start":0,"end":0.5,"text":"hello"}\\n\'); time.sleep(10)')
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(len(result['transcript']), 1)
        self.assertIn('仅学习部分音频', result['error'])

    async def test_timeout_without_segments_is_not_success(self):
        result = await self.run_asr('import time; time.sleep(10)')
        self.assertEqual(result['status'], 'unavailable')
        self.assertIn('本次未学习音频', result['error'])
        self.assertIn('尚无转写结果', result['error'])
        self.assertEqual(result['transcript'], [])

if __name__ == '__main__':
    unittest.main()
