import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

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

    @patch.object(MODULE.requests, "post")
    @patch.object(MODULE.requests, "get")
    def test_posts_note_id_and_selects_highest_video(self, get, post):
        redirect = get.return_value
        redirect.url = "https://www.xiaohongshu.com/discovery/item/abc123"
        redirect.raise_for_status.return_value = None
        response = post.return_value
        response.status_code = 200
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "code": 0,
            "data": {
                "items": [{
                    "note_detail": {
                        "video": {
                            "video_progressive": [
                                {"height": 720, "url": "https://cdn.example/720.mp4"},
                                {"height": 1080, "url": "https://cdn.example/1080.mp4"},
                            ]
                        }
                    }
                }]
            },
        }
        result = MODULE.resolve(
            "https://xhslink.com/demo", 6, "https://provider.example/feed"
        )
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["video_url"], "https://cdn.example/1080.mp4")
        post.assert_called_once()
        self.assertEqual(
            post.call_args.kwargs["json"], {"source_note_id": "abc123"}
        )


if __name__ == "__main__":
    unittest.main()
