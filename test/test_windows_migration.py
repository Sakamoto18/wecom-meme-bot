import importlib.util
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/douyin-provider'))
import runtime_config
import profile_guard

spec = importlib.util.spec_from_file_location('restore_sqlite', ROOT / 'scripts/windows/restore_sqlite.py')
restore_sqlite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore_sqlite)


class RuntimeConfigTests(unittest.TestCase):
    def test_linux_keeps_container_defaults(self):
        with patch.object(runtime_config.sys, 'platform', 'linux'), patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runtime_config.douyin_profile_path(), Path('/data/profile'))
            options = runtime_config.browser_options()
            self.assertEqual(options['executable_path'], '/usr/bin/chromium')
            self.assertIn('--no-sandbox', options['args'])

    def test_windows_uses_native_edge_and_separate_profile(self):
        with patch.object(runtime_config.sys, 'platform', 'win32'), patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runtime_config.browser_options()['channel'], 'msedge')
            self.assertNotIn('executable_path', runtime_config.browser_options())
            self.assertEqual(runtime_config.douyin_profile_path(), ROOT / 'data/windows/douyin-profile')

    def test_explicit_browser_and_profile_override_defaults(self):
        with patch.dict(os.environ, {'MEDIA_BROWSER_EXECUTABLE': 'D:/browser.exe', 'DOUYIN_PROFILE': 'custom-profile'}):
            self.assertEqual(runtime_config.browser_options()['executable_path'], 'D:/browser.exe')
            self.assertEqual(runtime_config.douyin_profile_path(), Path('custom-profile').resolve())


def database(file, text):
    file.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(file)
    db.execute('CREATE TABLE sample(value TEXT)')
    db.execute('INSERT INTO sample VALUES (?)', (text,))
    db.commit()
    db.close()


class RestoreTests(unittest.TestCase):
    def test_failure_during_install_rolls_back_databases_and_journals(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / 'snapshot', root / 'live'
            for name in ('a.sqlite', 'b.sqlite'):
                database(source / name, 'new')
                database(target / name, 'original')
            (target / 'a.sqlite-wal').write_bytes(b'old-wal')
            originals = {p.name: p.read_bytes() for p in target.iterdir()}
            replace = Path.replace

            def fail_second(file, destination):
                if file.name == 'b.sqlite':
                    raise OSError('simulated disk error')
                return replace(file, destination)

            with patch.object(Path, 'replace', fail_second), self.assertRaises(OSError):
                restore_sqlite.restore(source, target, root / 'backups')
            self.assertEqual({p.name: p.read_bytes() for p in target.iterdir()}, originals)

    def test_restore_quarantines_only_matching_journals_and_preserves_other_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / 'snapshot', root / 'live'
            database(source / 'persona.sqlite', 'confirmed-persona')
            database(source / 'have-meme/meme.db', 'meme')
            database(target / 'persona.sqlite', 'old-persona')
            for suffix in ('-wal', '-shm', '-journal'):
                (target / ('persona.sqlite' + suffix)).write_bytes(b'old-journal')
            (target / 'unrelated-wal').write_bytes(b'preserve')
            (target / 'config.json').write_text('keep')
            report, backup = restore_sqlite.restore(source, target, root / 'backups')
            self.assertEqual(len(report), 2)
            for suffix in ('-wal', '-shm', '-journal'):
                self.assertFalse((target / ('persona.sqlite' + suffix)).exists())
                self.assertEqual((backup / ('persona.sqlite' + suffix)).read_bytes(), b'old-journal')
            self.assertEqual((target / 'unrelated-wal').read_bytes(), b'preserve')
            self.assertEqual((target / 'config.json').read_text(), 'keep')
            db = sqlite3.connect(target / 'persona.sqlite')
            try:
                self.assertEqual(db.execute('SELECT value FROM sample').fetchone()[0], 'confirmed-persona')
            finally:
                db.close()

    def test_corrupt_snapshot_does_not_change_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / 'snapshot', root / 'live'
            database(source / 'a.sqlite', 'good')
            (source / 'z.sqlite').write_bytes(b'broken-database')
            database(target / 'a.sqlite', 'original')
            original = (target / 'a.sqlite').read_bytes()
            with self.assertRaises((sqlite3.DatabaseError, ValueError)):
                restore_sqlite.restore(source, target, root / 'backups')
            self.assertEqual((target / 'a.sqlite').read_bytes(), original)


class ProfileGuardTests(unittest.TestCase):
    def test_exclusive_profile_lock_is_released_on_close(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / 'profile'
            proc = Path(directory) / 'no-proc'
            handle = profile_guard.acquire_profile(profile, proc)
            try:
                with self.assertRaises(OSError):
                    profile_guard.acquire_profile(profile, proc)
            finally:
                handle.close()
            with profile_guard.acquire_profile(profile, proc):
                pass


if __name__ == '__main__':
    unittest.main()
