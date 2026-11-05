import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services/douyin-provider'))
from learning_report import report_html, cover_url

class ReportTests(unittest.TestCase):
    def test_all_video_cards_have_covers_and_escaped_details(self):
        rows = [dict(bvid='BV1W44w62ExZ', title='黑猫<script>', status='learned', meaning='含义', usage=['场景'], replyHooks=['接法']),
                dict(bvid='BV1Epx96EEBG', title='灭建国', status='failed', error='播放失败')]
        result = report_html('日报\n主页\n进度\n下次继续：新视频', rows, {i['bvid']: 'data:image/png;base64,AAAA' for i in rows})
        self.assertEqual(result.count('<img '), 2)
        self.assertIn('黑猫&lt;script&gt;', result)
        self.assertIn('播放失败', result)
        self.assertIn('本次未学习音频', result)
        self.assertIn('下次继续：新视频', result)
        with self.assertRaises(ValueError): report_html('日报', rows, {})

    def test_cover_is_static_bilibili_image_only(self):
        self.assertEqual(cover_url('//i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg')
        self.assertEqual(cover_url('http://i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg')
        for value in ['https://localhost/a.jpg','https://i0.hdslb.com.evil.com/a.jpg']:
            with self.assertRaises(ValueError): cover_url(value)

if __name__ == '__main__': unittest.main()
