"""Image-level checks for the actual card renderer (no AstrBot dependency)."""
import io
import sys
import unittest
from pathlib import Path

from PIL import Image, ImageChops

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "astrbot_plugin_longtu_bridge"))
from video_card import render_video_card, card_footer, card_font, wrap_text


def png(color, size):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, "PNG")
    return output.getvalue()


class CardTests(unittest.TestCase):
    def render(self, metadata):
        return Image.open(io.BytesIO(render_video_card(metadata, png("navy", (540, 720)), png("red", (100, 100)))))

    def test_footer_below_portrait_cover_is_not_clipped(self):
        base = {"provider": "xiaohongshu", "title": "中文视频标题", "author": "原视频作者"}
        without = self.render(base)
        with_tags = self.render({**base, "tags": ["高达", "模型"]})
        self.assertGreater(with_tags.height, without.height)
        footer = with_tags.crop((0, without.height - 24, 760, with_tags.height))
        self.assertIsNotNone(ImageChops.difference(footer, Image.new("RGB", footer.size, "white")).getbbox())
        self.assertEqual(with_tags.getpixel((30, 30)), (255, 0, 0))

    def test_bilibili_always_displays_description_even_when_it_has_hashtags(self):
        description = "视频简介第一行\n#模型 第二行补充，不能只留下标签"
        self.assertEqual(card_footer({"provider": "bilibili", "description": description}), description)
        self.assertEqual(card_footer({"provider": "bilibili", "description": ""}), "")

    def test_no_fabricated_tags_or_platform_label(self):
        self.assertEqual(card_footer({"provider": "xiaohongshu", "description": "没有话题的正文"}), "")
        self.assertEqual(card_footer({"provider": "xiaohongshu", "description": "正文 #模型[话题]# #高达[话题]#"}), "#模型  #高达")

    def test_missing_author_never_uses_qq_sender_or_placeholder(self):
        card = Image.open(io.BytesIO(render_video_card({"provider": "xiaohongshu", "title": "标题", "senderName": "QQ发送者"})))
        header = card.crop((0, 0, 580, 76))
        self.assertIsNone(ImageChops.difference(header, Image.new("RGB", header.size, "white")).getbbox())

    def test_official_logos_are_horizontal_wordmarks(self):
        from video_card import ASSETS, LOGOS
        for name in LOGOS.values():
            with Image.open(ASSETS / "logos" / name) as logo:
                self.assertGreater(logo.width / logo.height, 1.6)

    def test_wrapping_respects_newlines_and_available_width(self):
        font = card_font(22)
        lines = wrap_text("简介第一段\n" + "模型介绍" * 40, font, 712)
        self.assertEqual(lines[0], "简介第一段")
        self.assertTrue(all(font.getlength(line) <= 712 for line in lines))


if __name__ == "__main__":
    unittest.main()
