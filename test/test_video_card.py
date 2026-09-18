"""Image-level checks for the actual card renderer (no AstrBot dependency)."""
import io
import sys
import unittest
from pathlib import Path

from PIL import Image, ImageChops

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "astrbot_plugin_longtu_bridge"))
from video_card import (render_video_card, card_footer, card_font, wrap_text,
                        text_clusters, text_width, gallery_grid, is_emoji,
                        emoji_tile, renderable_text)


def png(color, size):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, "PNG")
    return output.getvalue()


class CardTests(unittest.TestCase):
    def test_small_bullets_are_text_and_emoji_keep_font_cell_padding(self):
        self.assertFalse(is_emoji("▪️"))
        self.assertFalse(is_emoji("▫️"))
        tile = emoji_tile("🔥", 22)
        bounds = tile.getbbox()
        self.assertTrue(bounds[0] > 0 or bounds[1] > 0 or bounds[2] < tile.width or bounds[3] < tile.height)

    def test_private_use_emoji_uses_the_bundled_color_font(self):
        # QQ native emoji commonly arrives as FE82C/FE82E-style private-use
        # characters.  They must not go through the CJK font and become tofu.
        private_emoji = "\U000fe82c"
        self.assertTrue(is_emoji(private_emoji))
        tile = emoji_tile(private_emoji, 22)
        self.assertIsNotNone(tile)
        self.assertIsNotNone(tile.getbbox())

    def test_symbol_fallback_does_not_send_text_symbols_to_color_emoji(self):
        # These characters occur in Douyin/Xiaohongshu titles and nicknames;
        # treating the hollow heart as a color emoji produces a tofu square.
        self.assertFalse(is_emoji("♡"))
        self.assertEqual(renderable_text("﹢"), "+")
        self.assertEqual(renderable_text("˚"), "°")

    def test_grid_preserves_order_and_only_last_cell_has_overflow(self):
        colors = [(20 * i, 40, 60) for i in range(9)]
        previews = [png(color, (80, 120)) for color in colors]
        nine = gallery_grid(previews, 9)
        ten = gallery_grid(previews, 10)
        self.assertEqual(nine.size, (712, 712))
        for i, color in enumerate(colors):
            point = ((i % 3) * 239 + 10, (i // 3) * 239 + 10)
            self.assertEqual(nine.getpixel(point), color)
            if i < 8: self.assertEqual(ten.getpixel(point), color)
        difference = ImageChops.difference(nine, ten).getbbox()
        self.assertGreaterEqual(difference[0], 478)
        self.assertGreaterEqual(difference[1], 478)
        self.assertNotEqual(ten.tobytes(), gallery_grid(previews, 12).tobytes())

    def test_grid_failed_preview_keeps_its_slot(self):
        grid = gallery_grid([b'invalid', png('red', (80, 120))], 2)
        self.assertEqual(grid.getpixel((10, 10)), (238, 238, 238))
        self.assertEqual(grid.getpixel((370, 10)), (255, 0, 0))

    def test_title_and_body_render_colored_emoji(self):
        card = Image.open(io.BytesIO(render_video_card({
            "title": "强化型ZZ🔥", "description": "ZZ党😭🧨📌⚠️▪️", "provider": "xiaohongshu",
        })))
        def colored_pixels(region):
            return sum(max(pixel) - min(pixel) > 70 and pixel[0] > pixel[2] + 40
                       for pixel in card.crop(region).getdata())
        self.assertGreater(colored_pixels((24, 82, 500, 122)), 20)
        self.assertGreater(colored_pixels((24, 166, 500, 200)), 20)

    def test_wrapping_keeps_combined_emoji_intact(self):
        clusters = ["👩🏽‍💻", "🇨🇳", "1️⃣", "⚠️", "▪️"]
        self.assertEqual(text_clusters("".join(clusters)), clusters)
        font = card_font(22)
        lines = wrap_text("".join(clusters), font, 48)
        self.assertEqual("".join(lines), "".join(clusters))
        self.assertTrue(all(text_width(line, font) <= 48 for line in lines))
        self.assertTrue(all(not line.startswith(("‍", "️", "🏽")) for line in lines))

    def test_bilibili_publication_time_is_under_author(self):
        metadata = {"provider": "bilibili", "title": "标题", "author": "UP主"}
        blank = self.render(metadata)
        dated = self.render({**metadata, "publishedAt": 1789113600})
        region = (78, 55, 300, 79)
        self.assertIsNotNone(ImageChops.difference(blank.crop(region), dated.crop(region)).getbbox())
        self.assertEqual(blank.size, dated.size)

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
        self.assertEqual(card_footer({"provider": "xiaohongshu", "description": "没有话题的正文"}), "没有话题的正文")
        self.assertEqual(card_footer({"provider": "xiaohongshu", "description": "正文 #模型[话题]# #高达[话题]#"}), "正文 #模型# #高达#")

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

    def test_unreadable_cover_or_avatar_still_renders_the_card(self):
        """CDN 拒绝时返回的错误页不能让整张卡片消失。"""
        message = {"title": "测试标题", "author": "作者", "provider": "douyin",
                   "description": "简介", "tags": ["标签"]}
        error_page = b"<html><head><title>403 Forbidden</title></head><body>x</body></html>"
        truncated = b"\xff\xd8\xff\xe0\x00\x10JFIF"
        baseline = len(render_video_card(message, b"", b""))
        for label, cover, avatar in (
            ("cover 是错误页", error_page, b""),
            ("cover 被截断", truncated, b""),
            ("avatar 是错误页", b"", error_page),
            ("两个都坏", error_page, error_page),
        ):
            with self.subTest(label):
                # 坏图退化成无封面卡片，而不是抛异常或返回空。
                self.assertEqual(len(render_video_card(message, cover, avatar)), baseline)

    def test_readable_cover_is_still_drawn(self):
        message = {"title": "测试标题", "author": "作者", "provider": "douyin"}
        with_cover = render_video_card(message, png("red", (720, 1280)), b"")
        without_cover = render_video_card(message, b"", b"")
        self.assertGreater(len(with_cover), len(without_cover))
        with Image.open(io.BytesIO(with_cover)) as card:
            self.assertGreater(card.height, 760)


if __name__ == "__main__":
    unittest.main()
