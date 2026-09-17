"""Exercise the Bridge method against a CDN requiring a source Referer."""
import ast
import base64
import logging
from pathlib import Path
from types import SimpleNamespace
import unittest

source = ast.parse((Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/main.py').read_text())
bridge = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
method = next(n for n in bridge.body if getattr(n, 'name', '') == '_video_card')


class AvatarTests(unittest.IsolatedAsyncioTestCase):
    async def test_xhs_cdn_avatar_is_passed_to_renderer_with_required_headers(self):
        captured = {}
        class Response:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            def raise_for_status(self):
                if captured['headers'].get('Referer') != 'https://www.xiaohongshu.com/':
                    raise RuntimeError('403 Forbidden')
            async def read(self): return b'original-author-avatar'
        class Session:
            def get(self, url, **kwargs):
                captured.update(kwargs)
                return Response()
        def render(message, cover, avatar):
            captured['avatar'] = avatar
            return b'card-png'
        # 真实的 signed_url 依赖 yarl；这里只关心请求头，用替身并记录调用，
        # 以此守住“头像地址也必须经过 signed_url”。编码行为由
        # test_signed_url.py 覆盖。
        wrapped = []
        def fake_signed_url(value):
            wrapped.append(value)
            return value
        namespace = {'aiohttp': SimpleNamespace(ClientTimeout=lambda **kwargs: kwargs),
                     'base64': base64, 'logger': logging.getLogger('test'),
                     'render_video_card': render, 'signed_url': fake_signed_url}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), '<bridge>', 'exec'), namespace)
        result = await namespace['_video_card'](SimpleNamespace(session=Session()), {
            'provider': 'xiaohongshu', 'author': '野生小笼包',
            'avatarUrl': 'https://sns-avatar-qc.xhscdn.com/avatar/source',
        })
        self.assertEqual(captured['avatar'], b'original-author-avatar')
        self.assertEqual(captured['headers']['User-Agent'], 'Mozilla/5.0')
        self.assertEqual(base64.b64decode(result), b'card-png')
        self.assertIn('https://sns-avatar-qc.xhscdn.com/avatar/source', wrapped)


if __name__ == '__main__': unittest.main()
