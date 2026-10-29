"""Restore standalone SQLite snapshots while quarantining old WAL/SHM journals.

Only run with every bot service stopped. Never run against a live deployment.
The source snapshot directory and original compressed archives are left intact.
"""
import argparse
import hashlib
import json
import shutil
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def validate(file):
    with file.open('rb') as stream:
        if stream.read(16) != b'SQLite format 3\0':
            raise ValueError(f'Not a complete SQLite snapshot: {file.name}')
    for suffix in ('-wal', '-shm', '-journal'):
        if Path(str(file) + suffix).exists():
            raise ValueError(f'Source must be a standalone snapshot: {file.name}{suffix}')
    db = sqlite3.connect(file.as_uri() + '?mode=ro&immutable=1', uri=True)
    try:
        rows = db.execute('PRAGMA quick_check').fetchall()
        if rows != [('ok',)]:
            raise ValueError(f'SQLite integrity check failed: {file.name}')
    finally:
        db.close()


def restore(source, target, backup_root):
    source, target, backup_root = map(lambda p: Path(p).resolve(), (source, target, backup_root))
    if source == target or source in target.parents or target in source.parents:
        raise ValueError('Source and destination must be separate directories.')
    if backup_root == target or target in backup_root.parents:
        raise ValueError('Backup must be outside the live data directory.')
    files = sorted(p for p in source.rglob('*') if p.is_file() and p.suffix in ('.sqlite', '.db'))
    if not files:
        raise ValueError('No SQLite snapshots found; nothing was changed.')
    for file in files:
        if file.is_symlink() or source not in file.resolve().parents:
            raise ValueError('Snapshot symlinks are not accepted.')
        validate(file)
    target.mkdir(parents=True, exist_ok=True)
    backup_root.mkdir(parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix='before-native-', dir=backup_root))
    moved, installed, report = [], [], []
    with tempfile.TemporaryDirectory(prefix='.sqlite-stage-', dir=target.parent) as stage_name:
        stage = Path(stage_name)
        # Stage every file and compare hashes before modifying any destination.
        for file in files:
            relative = file.relative_to(source)
            destination = target / relative
            if target not in destination.resolve().parents:
                raise ValueError(f'Destination escapes data directory: {relative}')
            staged = stage / relative
            staged.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, staged)
            expected = digest(file)
            if digest(staged) != expected:
                raise ValueError(f'Staged copy mismatch: {relative}')
            report.append({'file': relative.as_posix(), 'sha256': expected})
        try:
            for file in files:
                relative = file.relative_to(source)
                destination = target / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                for suffix in ('', '-wal', '-shm', '-journal'):
                    existing = Path(str(destination) + suffix)
                    if existing.exists() or existing.is_symlink():
                        archived = backup / (str(relative) + suffix)
                        archived.parent.mkdir(parents=True, exist_ok=True)
                        existing.rename(archived)
                        moved.append((existing, archived))
                (stage / relative).replace(destination)
                installed.append(destination)
            for item in report:
                if digest(target / item['file']) != item['sha256']:
                    raise ValueError(f"Installed copy mismatch: {item['file']}")
        except BaseException:
            for file in reversed(installed):
                file.unlink(missing_ok=True)
            for original, archived in reversed(moved):
                archived.rename(original)
            raise
    manifest = {'time': datetime.now(timezone.utc).isoformat(), 'files': report}
    (backup / 'RESTORE.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(f'Restored and hash-verified {len(report)} databases. Old databases/journals: {backup}')
    return report, backup


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, help='consistent-sqlite/data directory')
    parser.add_argument('--target', required=True, help='project data directory')
    parser.add_argument('--backup-root', required=True)
    parser.add_argument('--services-stopped', action='store_true')
    args = parser.parse_args()
    if not args.services_stopped:
        parser.error('Stop Node, AstrBot and all database writers, then pass --services-stopped.')
    restore(args.source, args.target, args.backup_root)
