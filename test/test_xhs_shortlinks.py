"""Exercise the deployed Spider entry without installing its API dependencies."""
import ast
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main
from unittest.mock import Mock
from urllib.parse import urlsplit


source = ast.parse((Path(__file__).resolve().parents[1] / 'services/spider-xhs/provider.py').read_text())
resolve_node = next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == 'resolve')
resolve_node.decorator_list = []


class XhsShortlinkTests(TestCase):
    def resolver(self, public_content=None):
        canonical = 'https://www.xiaohongshu.com/explore/note123?xsec_token=a%2Bb%3D'
        response = SimpleNamespace(text='page', url=canonical)
        requests = SimpleNamespace(get=Mock(return_value=response))
        api = Mock()
        api.get_note_info.return_value = (True, '', {'data': {'items': [{'note_card': {'title': '笔记'}}]}})
        ns = {'Req': object, 'requests': requests, 'urlsplit': urlsplit,
              'note_url_from_response': Mock(return_value=canonical),
              'parse_public_note': Mock(return_value=public_content),
              'normalize_note': Mock(return_value={'title': '笔记'}), 'get_api': Mock(return_value=api)}
        exec(compile(ast.Module(body=[resolve_node], type_ignores=[]), '<provider>', 'exec'), ns)
        return ns, api, requests, canonical

    def test_both_shortlink_domains_redirect_before_detail_api(self):
        for url in ('https://xhslink.cn/o/6IV5SHvQTnX', 'http://xhslink.cn/o/test',
                    'https://xhslink.com/m/test', 'https://www.xhslink.cn/o/test'):
            with self.subTest(url=url):
                ns, api, requests, canonical = self.resolver()
                self.assertEqual(ns['resolve'](SimpleNamespace(url=url))['status'], 'success')
                requests.get.assert_called_once_with(url, allow_redirects=True, timeout=10)
                api.get_note_info.assert_called_once_with(canonical)

    def test_public_note_content_avoids_duplicate_api_call(self):
        content = {'media_type': 'gallery', 'images': ['https://cdn.example/1.jpg']}
        ns, api, _, _ = self.resolver(public_content=content)
        self.assertEqual(ns['resolve'](SimpleNamespace(url='https://xhslink.cn/o/test')),
                         {'status': 'success', 'data': content})
        api.get_note_info.assert_not_called()

    def test_note_page_is_not_treated_as_shortlink(self):
        ns, api, requests, canonical = self.resolver()
        ns['resolve'](SimpleNamespace(url=canonical))
        requests.get.assert_not_called()
        api.get_note_info.assert_called_once_with(canonical)


if __name__ == '__main__':
    main()
