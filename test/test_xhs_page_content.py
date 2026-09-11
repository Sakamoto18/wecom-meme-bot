import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('page_content', Path(__file__).resolve().parents[1] / 'services/spider-xhs/page_content.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PublicContentTests(unittest.TestCase):
    def test_error_redirect_keeps_note_address_and_complete_token(self):
        target = 'https://www.xiaohongshu.com/discovery/item/6a9943b9000000000b00f1b2?xsec_token=a%2Bb%3D&xsec_source=app_share'
        response = SimpleNamespace(url='https://www.xiaohongshu.com/website-login/error', history=[
            SimpleNamespace(url='https://xhslink.com/m/47pnZUAJib8'), SimpleNamespace(url=target)])
        self.assertEqual(module.note_url_from_response(response), target)

    def test_error_page_is_not_a_note_id(self):
        with self.assertRaises(ValueError):
            module.note_url_from_response(SimpleNamespace(history=[], url='https://www.xiaohongshu.com/website-login/error'))

    def test_normal_note_ignores_video_field_and_preserves_tags(self):
        result = module.normalize_note({'type': 'normal', 'desc': '#英语[话题]#',
            'image_list': [{'info_list': [{'url': 'https://cdn.example/1.jpg'}]}],
            'video': {'media': {'stream': {'h264': [{'url': 'https://cdn.example/unrelated.mp4'}]}}}})
        self.assertEqual(result['description'], '#英语#')
        self.assertEqual(result['media_type'], 'gallery')
        self.assertEqual(result['images'], ['https://cdn.example/1.jpg'])
        self.assertEqual(result['video_url'], '')

    def test_video_with_cover_returns_only_video(self):
        result = module.normalize_note({'type': 'video', 'image_list': [{'url': 'https://cdn.example/cover.jpg'}],
            'video': {'media': {'stream': {'h264': [
                {'height': 1080, 'master_url': 'https://cdn.example/1080.mp4'},
                {'height': 720, 'master_url': 'https://cdn.example/720.mp4'}]}}}})
        self.assertEqual(result['media_type'], 'video')
        self.assertEqual(result['video_url'], 'https://cdn.example/720.mp4')
        self.assertEqual(result['images'], [])

    def test_video_without_stream_cannot_return_cover_gallery(self):
        with self.assertRaises(ValueError):
            module.normalize_note({'type': 'video', 'image_list': [{'url': 'https://cdn.example/cover.jpg'}]})

    def test_actual_provider_preserves_note_user_and_topics(self):
        result = module.normalize_note({'type': 'video', 'title': '真实原作者',
            'user': {'nickname': '作者甲', 'avatar': 'https://cdn.example/author.jpg'},
            'tagList': [{'name': '高达'}, {'name': '模型'}], 'desc': '正文 #高达[话题]#',
            'imageList': [{'urlDefault': 'https://cdn.example/cover.jpg'}],
            'video': {'media': {'stream': {'h264': [{'height': 720, 'masterUrl': 'https://cdn.example/video.mp4'}]}}}})
        self.assertEqual(result['author'], '作者甲')
        self.assertEqual(result['avatarUrl'], 'https://cdn.example/author.jpg')
        self.assertEqual(result['tags'], ['高达', '模型'])
        self.assertEqual(result['description'], '正文 #高达#')
        self.assertEqual(result['images'], [])

    def test_unknown_type_is_not_success(self):
        with self.assertRaises(ValueError):
            module.normalize_note({'type': 'unknown'})

    def test_page_state_with_undefined_and_real_structure(self):
        note = {'noteId': 'test', 'type': 'normal', 'desc': 'undefined #test[话题]#',
                'imageList': [{'urlDefault': 'https://cdn.example/1.jpg'}]}
        state = json.dumps({'note': {'noteDetailMap': {'test': {'note': note}}}, 'optional': '__UNDEF__'}).replace('"__UNDEF__"', 'undefined')
        result = module.parse_public_note('<script>window.__INITIAL_STATE__='+state+'</script>', 'https://www.xiaohongshu.com/explore/test')
        self.assertEqual(result['images'], ['https://cdn.example/1.jpg'])
        self.assertEqual(result['description'], 'undefined #test#')


if __name__ == '__main__':
    unittest.main()
