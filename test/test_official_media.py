"""Protocol fixtures only; no live QQ sends or web requests."""
import unittest
from types import SimpleNamespace
from astrbot_plugin_longtu_bridge.official_media import extract_official_media

BVID = 'BV1DV5v6HELu'
VIDEO = 'https://www.bilibili.com/video/' + BVID
ENVELOPE = ('[卡片消息] 小程序\n摘要: [QQ小程序]这严苛的训练几乎要了蛋的命!\n'
            'source: 哔哩哔哩\n'
            'source_logo: https://open.gtimg.cn/open/app_icon/00/95/17/76/100951776_100_m.png\n'
            'title: 这严苛的训练几乎要了蛋的命!\n'
            'preview: https://qq.ugcimg.cn/v1/example')


def extract(data=None, content=''):
    return extract_official_media(SimpleNamespace(raw_data=data or {}, content=content))


class OfficialMediaTests(unittest.TestCase):
    def test_observed_1822_envelope_has_no_video_and_drops_assets(self):
        # 2026-11-23 10:32:11 live re-share: message_type=3, ark fields
        # contain display metadata only. Identity and opaque assets are omitted.
        result = extract({'message_type': 3, 'ark_data': {'fields': {
            'source': '哔哩哔哩', 'title': '这严苛的训练几乎要了蛋的命!',
            'source_logo': 'https://open.gtimg.cn/app_icon.png',
            'preview': 'https://qq.ugcimg.cn/v1/example'}}, 'content': ENVELOPE})
        self.assertTrue(result['bilibili_card'])
        self.assertEqual(result['video_urls'], [])
        self.assertEqual(result['segments'], [])
        self.assertNotIn('这严苛', str(result['diagnostic']))

    def test_nested_json_and_escaped_player_preserve_part(self):
        result = extract({'msg_elements': [{'ark_data':
            '{"meta":{"detail_1":{"qqdocurl":"https:\\/\\/player.bilibili.com/player.html?bvid=' + BVID + '&amp;page=2"}}}'}]})
        self.assertEqual(result['video_urls'], [VIDEO + '?p=2'])

    def test_structured_id_page_and_deep_link(self):
        for fields in [{'bvid': BVID}, {'path': 'pages/video/video?bvid=' + BVID},
                       {'url': 'bilibili://video/' + BVID}]:
            with self.subTest(fields=fields):
                result = extract({'ark_data': {'source': '哔哩哔哩', **fields}})
                self.assertEqual(result['video_urls'], [VIDEO])
        self.assertEqual(extract({'ark_data': {'url': 'bilibili://video/123456'}})['video_urls'],
                         ['https://www.bilibili.com/video/av123456'])

    def test_encoded_redirect_and_video_not_lost_after_many_asset_links(self):
        result = extract({'ark_data': {'source': '哔哩哔哩',
            'unused': [f'https://example.org/{i}' for i in range(30)],
            'jumpurl': 'https://example.org/jump?target=https%253A%252F%252Fwww.bilibili.com%252Fvideo%252F' + BVID}})
        self.assertEqual(result['video_urls'], [VIDEO])
        self.assertEqual(result['segments'][0]['data']['url'], VIDEO)

    def test_plain_text_and_unrelated_ids_do_not_invent_bili_videos(self):
        for data in [{'bvid': BVID}, {'aid': '123456'}, {'title': BVID},
                     {'url': 'https://bilibili.com.example.org/video/' + BVID},
                     {'source': '其他小程序', 'path': 'pages/video?aid=123456'}]:
            self.assertEqual(extract(data)['video_urls'], [])
        self.assertFalse(extract(content='为什么哔哩哔哩小程序打不开')['bilibili_card'])
        self.assertFalse(extract({'source': '其他小程序', 'title': '哔哩哔哩'})['bilibili_card'])

    def test_quoted_and_identity_links_are_not_current_shares(self):
        result = extract({'message_type': 103, 'author': {'url': VIDEO},
                          'msg_elements': [{'content': VIDEO}]})
        self.assertEqual(result['segments'], [])
        self.assertNotIn(VIDEO, str(result['diagnostic']))

    def test_short_links_generic_links_and_live_behavior(self):
        self.assertEqual(extract(content='https://b23.tv/test')['video_urls'], ['https://b23.tv/test'])
        self.assertEqual(extract(content='https://example.org/article')['segments'][0]['data']['url'],
                         'https://example.org/article')
        self.assertEqual(extract(content='https://live.bilibili.com/123')['video_urls'], [])

    def test_bad_or_oversized_fields_are_bounded(self):
        result = extract({'ark_data': ['{' * (256 * 1024 + 1), {'url': 'http://['}]})
        self.assertTrue(result['diagnostic']['truncated'])
        self.assertEqual(result['video_urls'], [])

    def test_serialized_top_level_ark_keeps_direct_url_extraction(self):
        import json
        result = extract({'ark_data': json.dumps({'source': '哔哩哔哩', 'bvid': BVID})})
        self.assertEqual(result['video_urls'], [VIDEO])
        self.assertIsNone(result['search_card'])
