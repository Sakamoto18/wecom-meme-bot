import importlib.util
from pathlib import Path
import unittest

MODULE_PATH = Path(__file__).parents[1] / "src" / "parser" / "xhs_resolver.py"
SPEC = importlib.util.spec_from_file_location("xhs_resolver", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class XhsResolverTest(unittest.TestCase):
    def test_signature_placeholder_remains_empty(self):
        self.assertEqual(MODULE.build_signed_headers({}, "1"), {})

    def test_extract_note_id(self):
        self.assertEqual(
            MODULE.extract_note_id("https://www.xiaohongshu.com/discovery/item/abc123?x=1"),
            "abc123",
        )

    def test_selects_highest_bitrate_mp4(self):
        parsed = MODULE.parse_detail({
            "cover": "https://cdn.example/cover.jpg",
            "streams": [
                {"height": 720, "url": "https://cdn.example/low.mp4"},
                {"height": 1080, "url": "https://cdn.example/high.mp4"},
            ],
            "watermark": False,
        })
        self.assertEqual(parsed["video_url"], "https://cdn.example/high.mp4")
        self.assertFalse(parsed["watermarked"])


if __name__ == "__main__":
    unittest.main()
