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
    script = next(n.value.value for n in tree.body if isinstance(n, ast.Assign) and any(getattr(t, 'id', '') == 'EXTRACT_SCRIPT' for t in n.targets))
    ns = dict(asyncio=asyncio, html=html, logger=logging.getLogger('test'), time=time,
              urlsplit=urlsplit, suppress=suppress, Req=object, PlaywrightTimeoutError=TimeoutError,
              QUEUE_TIMEOUT=.05, RESOLVE_TIMEOUT=.02, NAVIGATION_TIMEOUT_MS=10,
              EXTRACT_SCRIPT=script, GALLERY_SCRIPT='gallery-script', lock=asyncio.Lock())
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<provider>', 'exec'), ns)
    return ns


class RequestTests(unittest.IsolatedAsyncioTestCase):
    def test_douyin_vod_resource_is_a_real_video(self):
        ns = runtime()
        self.assertTrue(ns['is_real_video_url'](
            'https://v26-web.douyinvod.com/abc/def/video/tos/cn/file?mime_type=video_mp4',
        ))

    async def test_dom_timeout_still_extracts_loaded_video(self):
        ns = runtime()
        page = SimpleNamespace(goto=AsyncMock(side_effect=TimeoutError()), wait_for_timeout=AsyncMock(),
            evaluate=AsyncMock(side_effect=[None, {'video': 'https://cdn.example/a.mp4', 'title': 'target'}]))
        result = await ns['read_page'](page, 'https://v.douyin.com/test/', [], {})
        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['data']['video_url'], 'https://cdn.example/a.mp4')

    async def test_note_gallery_takes_precedence_over_animated_video_elements(self):
        ns = runtime()
        images = ['https://cdn.example/image-1.webp', 'https://cdn.example/image-2.webp']
        extracted = {
            'path': '/note/example', 'title': '图文作品', 'desc': '正文',
            'author': '作者', 'avatar': '', 'tags': [], 'cover': images[0],
            'covers': images,
            'videos': [
                {'video': 'https://cdn.example/animated-1.mp4', 'cover': images[0]},
                {'video': 'https://cdn.example/animated-2.mp4', 'cover': images[1]},
            ],
            'video': 'https://cdn.example/animated-1.mp4',
        }
        gallery_hint = {'total': 2, 'current': 1, 'items': []}
        page = SimpleNamespace(
            goto=AsyncMock(), wait_for_timeout=AsyncMock(),
            evaluate=AsyncMock(side_effect=[None, extracted, gallery_hint]),
        )
        ns['collect_gallery'] = AsyncMock(return_value=(images, 2))
        state = {}
        result = await ns['read_page'](page, 'https://www.douyin.com/note/example', [], state)
        self.assertEqual(result['data']['media_type'], 'images')
        self.assertEqual(result['data']['video_url'], '')
        self.assertEqual(result['data']['images'], images)
        self.assertEqual(
            [item['video_url'] for item in result['data']['animated_videos']],
            ['https://cdn.example/animated-1.mp4', 'https://cdn.example/animated-2.mp4'],
        )
        args = ns['collect_gallery'].await_args.args
        self.assertIs(args[0], page)
        self.assertIs(args[1], state)
        self.assertEqual(args[2], gallery_hint)

    async def test_note_single_video_waits_for_gallery_branch_before_video(self):
        ns = runtime()
        extracted = {
            'path': '/note/video-example', 'title': '视频作品', 'desc': '正文',
            'author': '作者', 'avatar': '', 'tags': [],
            'cover': 'https://cdn.example/video-cover.jpg',
            'covers': ['https://cdn.example/video-cover.jpg'],
            'videos': [{'video': 'https://cdn.example/video.mp4',
                        'cover': 'https://cdn.example/video-cover.jpg'}],
            'video': 'https://cdn.example/video.mp4',
        }
        # A single stream in the first snapshot must not bypass the note
        # gallery branch. Once the page settles and still exposes no gallery,
        # the same page is returned as a video.
        gallery_hint = {'total': 0, 'current': 0, 'items': []}
        page = SimpleNamespace(
            goto=AsyncMock(), wait_for_timeout=AsyncMock(),
            evaluate=AsyncMock(side_effect=[None, extracted, extracted, extracted, extracted,
                                            extracted, extracted, extracted, gallery_hint]),
        )
        ns['collect_gallery'] = AsyncMock(return_value=([], 0))
        result = await ns['read_page'](
            page, 'https://www.douyin.com/note/video-example', [], {},
        )
        self.assertEqual(result['data']['media_type'], 'video')
        self.assertEqual(result['data']['video_url'], 'https://cdn.example/video.mp4')
        ns['collect_gallery'].assert_not_awaited()

    async def test_note_delayed_gallery_wins_over_first_video_snapshot(self):
        ns = runtime()
        extracted_video = {
            'path': '/note/gallery-example', 'title': '动态图文', 'desc': '正文',
            'author': '作者', 'avatar': '', 'tags': [],
            'cover': 'https://cdn.example/video-cover.jpg',
            'videos': [{'video': 'https://cdn.example/animated-1.mp4',
                        'cover': 'https://cdn.example/image-1.webp'}],
            'video': 'https://cdn.example/animated-1.mp4',
        }
        extracted_gallery = {
            **extracted_video,
            'covers': ['https://cdn.example/image-1.webp', 'https://cdn.example/image-2.webp'],
            'videos': [
                {'video': 'https://cdn.example/animated-1.mp4', 'cover': 'https://cdn.example/image-1.webp'},
                {'video': 'https://cdn.example/animated-2.mp4', 'cover': 'https://cdn.example/image-2.webp'},
            ],
        }
        first_gallery_hint = {'total': 0, 'current': 0, 'items': []}
        settled_gallery_hint = {'total': 2, 'current': 1, 'items': []}
        images = ['https://cdn.example/image-1.webp', 'https://cdn.example/image-2.webp']
        page = SimpleNamespace(
            goto=AsyncMock(), wait_for_timeout=AsyncMock(),
            evaluate=AsyncMock(side_effect=[
                None, extracted_video,
                extracted_gallery, settled_gallery_hint,
            ]),
        )
        ns['collect_gallery'] = AsyncMock(return_value=(images, 2))
        result = await ns['read_page'](
            page, 'https://www.douyin.com/note/gallery-example', [], {},
        )
        self.assertEqual(result['data']['media_type'], 'images')
        self.assertEqual(result['data']['video_url'], '')
        self.assertEqual(result['data']['images'], images)
        ns['collect_gallery'].assert_awaited_once()

    async def test_timeout_closes_page_releases_lock_and_next_request_succeeds(self):
        ns = runtime()
        page = SimpleNamespace(on=lambda *a: None, close=AsyncMock())
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
        page = SimpleNamespace(on=lambda *a: None, close=AsyncMock())
        ns['get_context'] = AsyncMock(return_value=SimpleNamespace(new_page=AsyncMock(return_value=page)))
        ns['read_page'] = AsyncMock(side_effect=RuntimeError('failed'))
        result = await ns['resolve'](SimpleNamespace(url='https://v.douyin.com/test/'))
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(ns['lock'].locked())
        page.close.assert_awaited_once()
