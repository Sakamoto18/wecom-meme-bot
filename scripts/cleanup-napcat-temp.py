#!/usr/bin/env python3
"""Remove yesterday's NapCat temporary files; never traverse login directories."""
import argparse
from datetime import datetime
import os
from pathlib import Path
import stat
from zoneinfo import ZoneInfo

TEMP_ROOT = Path("/opt/qqbot/ntqq/NapCat/temp")
TIMEZONE = ZoneInfo("Asia/Shanghai")


def midnight(now=None):
    now = now or datetime.now(TIMEZONE)
    return now.astimezone(TIMEZONE).replace(
        hour=0, minute=0, second=0, microsecond=0,
    ).timestamp()


def open_file_ids():
    """Inspect host processes, including Docker processes, without reading data."""
    result = set()
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            for descriptor in (process / "fd").iterdir():
                try:
                    info = descriptor.stat()
                    result.add((info.st_dev, info.st_ino))
                except (FileNotFoundError, ProcessLookupError):
                    pass
        except (FileNotFoundError, ProcessLookupError):
            pass
    return result


def clean(root, cutoff, opened, *, dry_run=True):
    root = Path(root)
    if root.is_symlink() or root.resolve(strict=True) != root or not root.is_dir():
        raise ValueError("Refusing a missing, relative or symlinked cleanup root")
    counts = {"files": 0, "bytes": 0, "kept": 0}
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
        for name in files:
            target = Path(directory) / name
            try:
                info = target.lstat()
                if (not stat.S_ISREG(info.st_mode)
                        or max(info.st_mtime, info.st_ctime) >= cutoff
                        or (info.st_dev, info.st_ino) in opened):
                    counts["kept"] += 1
                    continue
                # A file rewritten/replaced during the scan must be left alone.
                current = target.lstat()
                if current != info:
                    counts["kept"] += 1
                    continue
                if not dry_run:
                    target.unlink()
                counts["files"] += 1
                counts["bytes"] += info.st_size
            except FileNotFoundError:
                pass
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Only report; do not delete")
    args = parser.parse_args()
    cutoff = midnight()
    result = clean(TEMP_ROOT, cutoff, open_file_ids(), dry_run=args.dry_run)
    print(
        f"mode={'dry-run' if args.dry_run else 'delete'} root={TEMP_ROOT} "
        f"before={datetime.fromtimestamp(cutoff, TIMEZONE).isoformat()} "
        f"files={result['files']} bytes={result['bytes']} kept={result['kept']}",
        flush=True,
    )


if __name__ == "__main__":
    main()
