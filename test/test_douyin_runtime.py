"""Provider lifecycle and deadline regressions without launching a real browser."""
import ast
import asyncio
import importlib.util
import logging
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock
import html
from contextlib import suppress
from urllib.parse import urlsplit
import time
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services/douyin-provider"))
from work_metadata import PAGE_DATA_SCRIPT, work_id, page_payloads, find_work, normalize_work

ROOT = Path(__file__).resolve().parents[1] / 'services/douyin-provider'
spec = importlib.util.spec_from_file_location('profile_guard', ROOT / 'profile_guard.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ProfileTests(unittest.TestCase):
    def test_stale_container_lock_removed_but_login_data_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            profile = (Path(d) / 'profile').resolve()
            profile.mkdir()
            (profile / 'Cookies').write_bytes(b'login-data')
            for name in ('SingletonLock', 'SingletonCookie', 'SingletonSocket'):
                (profile / name).symlink_to('old-container-42')
            proc = Path(d) / 'proc'
            proc.mkdir()
            handle = guard.acquire_profile(profile, proc)
            try:
                self.assertEqual((profile / 'Cookies').read_bytes(), b'login-data')
                self.assertFalse((profile / 'SingletonLock').is_symlink())
                with self.assertRaises(BlockingIOError):
                    guard.acquire_profile(profile, proc)
            finally:
                handle.close()

    def test_live_browser_never_unlocked(self):
        with tempfile.TemporaryDirectory() as d:
            profile = (Path(d) / 'profile').resolve()
            profile.mkdir()
            (profile / 'SingletonLock').symlink_to('current-42')
            proc = Path(d) / 'proc'
            (proc / '42').mkdir(parents=True)
            (proc / '42' / 'cmdline').write_bytes(os.fsencode(f'chromium\0--user-data-dir={profile}\0'))
            with self.assertRaisesRegex(RuntimeError, 'already_running'):
                guard.acquire_profile(profile, proc)
            self.assertTrue((profile / 'SingletonLock').is_symlink())


def runtime():
    tree = ast.parse((ROOT / 'app.py').read_text())
    nodes = [n for n in tree.body if getattr(n, 'name', '') in ('is_real_video_url', 'read_page', 'resolve')]
    for node in nodes:
        node.decorator_list = []
    ns = dict(asyncio=asyncio, html=html, logger=logging.getLogger('test'), time=time,
              urlsplit=urlsplit, suppress=suppress, Req=object, PlaywrightTimeoutError=TimeoutError, PlaywrightError=RuntimeError,
              QUEUE_TIMEOUT=.05, RESOLVE_TIMEOUT=.02, NAVIGATION_TIMEOUT_MS=10,
              PAGE_DATA_SCRIPT=PAGE_DATA_SCRIPT, work_id=work_id, page_payloads=page_payloads,
              find_work=find_work, normalize_work=normalize_work, removed_marker=lambda text: '', lock=asyncio.Lock())
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<provider>', 'exec'), ns)
    return ns


class RequestTests(unittest.IsolatedAsyncioTestCase):
    def test_douyin_vod_resource_is_a_real_video(self):
        ns = runtime()
        self.assertTrue(ns['is_real_video_url'](
            'https://v26-web.douyinvod.com/abc/def/video/tos/cn/file?mime_type=video_mp4',
        ))

    async def test_delayed_target_metadata_ignores_previous_gallery(self):
        ns = runtime()
        previous = {'awemeId': '100', 'awemeType': 68,
                    'images': [{'urlList': ['https://cdn.example/old.webp']}]}
        target = {'aweme_id': '200', 'aweme_type': 0, 'desc': 'target',
                  'video': {'play_addr': {'url_list': ['https://cdn.example/target.mp4']}}}
        page = SimpleNamespace(url='https://www.douyin.com/video/200',
            goto=AsyncMock(side_effect=TimeoutError()), wait_for_timeout=AsyncMock(),
            evaluate=AsyncMock(side_effect=[{'render': previous}, {'render': {'detail': target}}]))
        result = await ns['read_page'](page, 'https://v.douyin.com/test/', [previous], {})
        self.assertEqual(result['data']['source_id'], '200')
        self.assertEqual(result['data']['media_type'], 'video')
        self.assertEqual(result['data']['video_url'], 'https://cdn.example/target.mp4')
        page.wait_for_timeout.assert_awaited_once()

    async def test_client_redirect_retries_metadata_read(self):
        ns = runtime()
        target = {'aweme_id': '200', 'aweme_type': 0,
                  'video': {'play_addr': {'url_list': ['https://cdn.example/target.mp4']}}}
        page = SimpleNamespace(url='https://www.douyin.com/video/200',
            goto=AsyncMock(return_value=None), wait_for_timeout=AsyncMock(),
            evaluate=AsyncMock(side_effect=[RuntimeError('Execution context was destroyed'), {'render': target}]))
        result = await ns['read_page'](page, page.url, [], {})
        self.assertEqual(result['data']['media_type'], 'video')

    async def test_gallery_does_not_need_counter_or_player_hydration(self):
        ns = runtime()
        target = {'awemeId': '100', 'awemeType': 68, 'desc': 'gallery', 'images': [
            {'urlList': ['https://cdn.example/a.webp'],
             'video': {'playAddr': [{'src': 'https://cdn.example/a.mp4'}]}},
            {'urlList': ['https://cdn.example/b.webp']},
        ]}
        page = SimpleNamespace(url='https://www.douyin.com/note/100',
            goto=AsyncMock(return_value=None), wait_for_timeout=AsyncMock(),
            evaluate=AsyncMock(return_value={'render': target}))
        result = await ns['read_page'](page, page.url, [], {})
        self.assertEqual(result['data']['media_type'], 'images')
        self.assertEqual(result['data']['video_url'], '')
        self.assertEqual(len(result['data']['images']), 2)
        self.assertEqual(result['data']['animated_videos'][0]['image_index'], 0)
        page.wait_for_timeout.assert_not_awaited()

    async def test_unavailable_metadata_fails_without_dom_media_guess(self):
        ns = runtime()
        ns['time'] = SimpleNamespace(monotonic=iter([0, 9]).__next__)
        page = SimpleNamespace(url='https://www.douyin.com/video/200',
            goto=AsyncMock(return_value=None), evaluate=AsyncMock(return_value=''))
        with self.assertRaisesRegex(ValueError, 'work_metadata_unavailable'):
            await ns['read_page'](page, page.url, [], {})

    async def test_timeout_closes_page_releases_lock_and_next_request_succeeds(self):
        ns = runtime()
        page = SimpleNamespace(on=lambda *a: None, remove_listener=lambda *a: None, close=AsyncMock())
        ctx = SimpleNamespace(new_page=AsyncMock(return_value=page))
        ns['get_context'] = AsyncMock(return_value=ctx)
        async def hang(*args):
            await asyncio.Event().wait()
        ns['read_page'] = hang
        result = await ns['resolve'](SimpleNamespace(url='https://v.douyin.com/test/'))
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(ns['lock'].locked())
        page.close.assert_awaited_once()
        ns['read_page'] = AsyncMock(return_value={'status':'success','data':{'cover':''}})
        result = await ns['resolve'](SimpleNamespace(url='https://v.douyin.com/next/'))
        self.assertEqual(result['status'], 'success')

    async def test_queue_timeout_does_not_release_another_request_lock(self):
        ns = runtime()
        await ns['lock'].acquire()
        result = await ns['resolve'](SimpleNamespace(url='https://v.douyin.com/test/'))
        self.assertIn('stage=queue', result['msg'])
        self.assertTrue(ns['lock'].locked())
        ns['lock'].release()

    async def test_exception_closes_page(self):
        ns = runtime()
        page = SimpleNamespace(on=lambda *a: None, remove_listener=lambda *a: None, close=AsyncMock())
        ns['get_context'] = AsyncMock(return_value=SimpleNamespace(new_page=AsyncMock(return_value=page)))
        ns['read_page'] = AsyncMock(side_effect=RuntimeError('failed'))
        result = await ns['resolve'](SimpleNamespace(url='https://v.douyin.com/test/'))
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(ns['lock'].locked())
        page.close.assert_awaited_once()
