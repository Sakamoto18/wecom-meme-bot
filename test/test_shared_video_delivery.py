import asyncio
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge'))
from video_delivery_cache import VideoDeliveryCache, VideoForwardRejected


class SharedVideoTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.cache = VideoDeliveryCache()
        self.addAsyncCleanup(self.cache.close)

    async def test_three_groups_share_one_upload_then_each_gets_own_forward(self):
        started, finish = asyncio.Event(), asyncio.Event()
        uploads, forwards = [], []
        async def upload():
            uploads.append(True)
            started.set()
            await finish.wait()
            return {'message_id': 101}
        async def forward(message_id):
            forwards.append(message_id)
            return {'delivery': 'native-forward', 'reused_message_id': message_id}
        tasks = [asyncio.create_task(self.cache.deliver('bot', 'video', upload, forward)) for _ in range(3)]
        await started.wait()
        self.assertEqual(len(uploads), 1)
        finish.set()
        results = await asyncio.gather(*tasks)
        self.assertEqual(uploads, [True])
        self.assertEqual(forwards, [101, 101])
        self.assertEqual(sum('message_id' in r for r in results), 1)
        await self.cache.deliver('bot', 'video', upload, forward)
        self.assertEqual(uploads, [True])
        self.assertEqual(forwards, [101, 101, 101])

    async def test_failure_in_first_group_does_not_poison_other_groups(self):
        started, finish = asyncio.Event(), asyncio.Event()
        calls = []
        async def fail():
            calls.append('first')
            started.set()
            await finish.wait()
            raise RuntimeError('first group muted')
        async def upload():
            calls.append('replacement')
            return {'message_id': 202}
        async def forward(mid):
            calls.append(('forward', mid))
            return {'delivery': 'native-forward'}
        first = asyncio.create_task(self.cache.deliver('bot', 'video', fail, forward))
        await started.wait()
        others = [asyncio.create_task(self.cache.deliver('bot', 'video', upload, forward)) for _ in range(2)]
        await asyncio.sleep(0)
        finish.set()
        results = await asyncio.gather(first, *others, return_exceptions=True)
        self.assertIsInstance(results[0], RuntimeError)
        self.assertEqual(calls, ['first', 'replacement', ('forward', 202)])

    async def test_cancelled_event_does_not_cancel_shared_upload(self):
        started, finish = asyncio.Event(), asyncio.Event()
        uploads = []
        async def upload():
            uploads.append(True)
            started.set()
            await finish.wait()
            return {'message_id': 101}
        async def forward(mid):
            return {'reused_message_id': mid}
        first = asyncio.create_task(self.cache.deliver('bot', 'video', upload, forward))
        await started.wait()
        second = asyncio.create_task(self.cache.deliver('bot', 'video', upload, forward))
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        finish.set()
        self.assertEqual(await second, {'reused_message_id': 101})
        self.assertEqual(uploads, [True])

    async def test_explicit_rejection_reuploads_once_but_timeout_never_retries(self):
        calls = []
        async def upload():
            calls.append('upload')
            return {'message_id': len(calls)}
        async def reject(mid):
            calls.append('rejected')
            raise VideoForwardRejected('source recalled')
        await self.cache.deliver('bot', 'video', upload, reject)
        await self.cache.deliver('bot', 'video', upload, reject)
        self.assertEqual(calls, ['upload', 'rejected', 'upload'])
        async def timeout(mid):
            raise asyncio.TimeoutError()
        with self.assertRaises(asyncio.TimeoutError):
            await self.cache.deliver('bot', 'video', upload, timeout)
        self.assertEqual(calls, ['upload', 'rejected', 'upload'])

    async def test_expired_cache_and_different_bots_or_media_are_isolated(self):
        now = [0]
        self.cache.clock = lambda: now[0]
        calls = []
        async def upload():
            calls.append(True)
            return {'message_id': len(calls)}
        async def no_forward(mid):
            self.fail('unrelated or expired video must not be forwarded')
        await self.cache.deliver('bot-a', 'p1', upload, no_forward)
        await self.cache.deliver('bot-b', 'p1', upload, no_forward)
        await self.cache.deliver('bot-a', 'p2', upload, no_forward)
        now[0] = 601
        await self.cache.deliver('bot-a', 'p1', upload, no_forward)
        self.assertEqual(len(calls), 4)

    async def test_failed_upload_does_not_cache_and_cache_is_bounded(self):
        async def fail():
            raise RuntimeError('send failed')
        async def forward(mid):
            self.fail('failure cannot be reused')
        with self.assertRaises(RuntimeError):
            await self.cache.deliver('bot', 'failed', fail, forward)
        self.assertFalse(self.cache.completed)
        self.assertFalse(self.cache.inflight)
        self.cache.max_entries = 2
        async def upload():
            return {'message_id': 100}
        for key in ['one', 'two', 'three']:
            await self.cache.deliver('bot', key, upload, forward)
        self.assertEqual(list(self.cache.completed), [('bot', 'two'), ('bot', 'three')])

    async def test_unrelated_video_does_not_wait_for_slow_upload(self):
        started, finish = asyncio.Event(), asyncio.Event()
        async def slow():
            started.set()
            await finish.wait()
            return {'message_id': 1}
        async def fast():
            return {'message_id': 2}
        async def forward(mid):
            self.fail('different videos must not reuse')
        pending = asyncio.create_task(self.cache.deliver('bot', 'slow', slow, forward))
        await started.wait()
        self.assertEqual(await self.cache.deliver('bot', 'fast', fast, forward), {'message_id': 2})
        self.assertFalse(pending.done())
        finish.set()
        await pending

    async def test_concurrent_stale_source_rejections_share_one_replacement(self):
        uploads = []
        entered, finish = asyncio.Event(), asyncio.Event()
        async def upload():
            uploads.append(True)
            if len(uploads) > 1:
                entered.set()
                await finish.wait()
            return {'message_id': len(uploads)}
        async def forward(mid):
            if mid == 1:
                raise VideoForwardRejected('source recalled')
            return {'reused_message_id': mid}
        await self.cache.deliver('bot', 'video', upload, forward)
        tasks = [asyncio.create_task(self.cache.deliver('bot', 'video', upload, forward)) for _ in range(3)]
        await entered.wait()
        finish.set()
        results = await asyncio.gather(*tasks)
        self.assertEqual(len(uploads), 2)
        self.assertEqual(results, [{'message_id': 2}, {'reused_message_id': 2}, {'reused_message_id': 2}])

    async def test_late_rejection_cannot_discard_a_new_successful_upload(self):
        entered, reject_later = asyncio.Event(), asyncio.Event()
        calls = []
        async def upload():
            calls.append(True)
            return {'message_id': len(calls)}
        async def slow_reject(mid):
            if mid == 1:
                entered.set()
                await reject_later.wait()
                raise VideoForwardRejected('stale source')
            return {'reused_message_id': mid}
        async def reject(mid):
            raise VideoForwardRejected('stale source')
        await self.cache.deliver('bot', 'video', upload, reject)
        pending = asyncio.create_task(self.cache.deliver('bot', 'video', upload, slow_reject))
        await entered.wait()
        await self.cache.deliver('bot', 'video', upload, reject)
        reject_later.set()
        self.assertEqual(await pending, {'reused_message_id': 2})
        self.assertEqual(len(calls), 2)


if __name__ == '__main__':
    unittest.main()
