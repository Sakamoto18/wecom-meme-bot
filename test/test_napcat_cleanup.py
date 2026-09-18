import importlib.util
import os
from pathlib import Path
import tempfile
import time
import unittest
from datetime import datetime, timezone

SPEC = importlib.util.spec_from_file_location(
    "napcat_cleanup", Path(__file__).resolve().parents[1] / "scripts/cleanup-napcat-temp.py",
)
cleanup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cleanup)


class NapcatCleanupTests(unittest.TestCase):
    def test_cutoff_is_beijing_midnight(self):
        now = datetime(2026, 9, 19, 1, 0, tzinfo=timezone.utc)
        self.assertEqual(cleanup.midnight(now), datetime(
            2026, 9, 18, 16, 0, tzinfo=timezone.utc,
        ).timestamp())

    def test_only_closed_old_files_are_deleted_and_dry_run_preserves_all(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for name in ("old.mp4", "open.mp4", "today.mp4"):
                (root / name).write_bytes(b"video")
            cutoff = time.time() + 1
            os.utime(root / "today.mp4", (cutoff + 60, cutoff + 60))
            with (root / "open.mp4").open("rb") as opened_file:
                info = os.fstat(opened_file.fileno())
                opened = {(info.st_dev, info.st_ino)}
                preview = cleanup.clean(root, cutoff, opened)
                self.assertEqual(preview, {"files": 1, "bytes": 5, "kept": 2})
                self.assertTrue((root / "old.mp4").exists())
                self.assertEqual(cleanup.clean(root, cutoff, opened, dry_run=False), preview)
                self.assertFalse((root / "old.mp4").exists())
                self.assertTrue((root / "open.mp4").exists())
                self.assertTrue((root / "today.mp4").exists())

    def test_backdated_new_file_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            file = root / "just-copied.mp4"
            file.write_bytes(b"video")
            now = time.time()
            os.utime(file, (now - 86400, now - 86400))
            result = cleanup.clean(root, now - 60, set(), dry_run=False)
            self.assertEqual(result["files"], 0)
            self.assertTrue(file.exists())

    def test_links_cannot_delete_login_data_outside_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            root = base / "temp"
            profile = base / "login"
            root.mkdir()
            profile.mkdir()
            (profile / "Cookies").write_bytes(b"keep")
            (root / "linked-dir").symlink_to(profile, target_is_directory=True)
            (root / "linked-file").symlink_to(profile / "Cookies")
            result = cleanup.clean(root, time.time() + 1, set(), dry_run=False)
            self.assertEqual(result["files"], 0)
            self.assertTrue((profile / "Cookies").exists())
            with self.assertRaises(ValueError):
                cleanup.clean(root / "linked-dir", time.time() + 1, set(), dry_run=False)


if __name__ == "__main__":
    unittest.main()
