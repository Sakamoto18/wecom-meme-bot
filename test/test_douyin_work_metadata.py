import json
import sys
import unittest
from pathlib import Path
from urllib.parse import quote
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services/douyin-provider'))
from work_metadata import find_work, normalize_work, page_payloads, work_id


class WorkMetadataTests(unittest.TestCase):
    def gallery(self):
        return {'awemeId': '123', 'awemeType': 68, 'desc': '图文', 'images': [
            {'urlList': ['https://cdn.example/static.webp'], 'video': None},
            {'urlList': ['https://cdn.example/live.webp'], 'video': {
                'playAddr': [{'src': 'https://cdn.example/live.mp4'}], 'dataSize': 300}},
        ], 'video': {'playAddr': [{'src': 'https://cdn.example/music.mp3'}]}}

    def test_real_pace_frame_shape_and_encoded_render_data(self):
        detail = self.gallery()
        row = '7:' + json.dumps(['$', '$L9', None, {'awemeId': '123', 'aweme': {'detail': detail}}]) + '\n'
        for script in [
            {'id': '', 'text': 'self.__pace_f.push(' + json.dumps([1, row]) + ')'},
            {'id': 'RENDER_DATA', 'text': quote(json.dumps({'detail': detail}))},
        ]:
            roots = list(page_payloads({'scripts': [script]}))
            self.assertEqual(find_work(roots, '123'), detail)

    def test_wrong_id_and_untyped_parent_are_not_authoritative(self):
        target = self.gallery()
        other = {**target, 'awemeId': '456'}
        self.assertIsNone(find_work({'aweme': other}, '123'))
        self.assertEqual(find_work({'awemeId': '123', 'children': [other, target]}, '123'), target)
        self.assertIsNone(normalize_work(other, '123'))

    def test_mixed_gallery_preserves_index_and_never_uses_top_level_video(self):
        result = normalize_work(self.gallery(), '123')
        self.assertEqual(result['media_type'], 'images')
        self.assertEqual(result['video_url'], '')
        self.assertEqual(len(result['images']), 2)
        self.assertEqual(len(result['animated_videos']), 1)
        self.assertEqual(result['animated_videos'][0]['image_index'], 1)
        self.assertEqual(result['animated_videos'][0]['video_url'], 'https://cdn.example/live.mp4')

    def test_unknown_or_incomplete_never_becomes_video(self):
        for detail in [
            {**self.gallery(), 'images': []},
            {**self.gallery(), 'awemeType': 999},
            {**self.gallery(), 'awemeType': 0},
            {'aweme_id': '123', 'aweme_type': 0, 'video': {}},
        ]:
            self.assertIsNone(normalize_work(detail, '123'))

    def test_api_video_uses_target_stream_and_size(self):
        result = normalize_work({'aweme_id': '123', 'aweme_type': 0, 'images': None,
            'video': {'play_addr': {'url_list': ['https://cdn.example/movie.mp4'], 'data_size': 42}}}, '123')
        self.assertEqual(result['media_type'], 'video')
        self.assertEqual(result['size'], 42)
        self.assertEqual(result['images'], [])

    def test_url_only_supplies_id_never_type(self):
        self.assertEqual(work_id('https://www.douyin.com/note/123'), '123')
        self.assertEqual(work_id('https://www.douyin.com/?modal_id=123'), '123')
        self.assertEqual(work_id('https://v.douyin.com/abc/'), '')
