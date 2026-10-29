"""Protect the dedicated local profile; preserve cookies across container rebuilds."""
import os
from pathlib import Path

if os.name == 'nt':
    import msvcrt
else:
    import fcntl


def lock_file(guard):
    if os.name == 'nt':
        # msvcrt locks a byte range from the current position until close().
        guard.seek(0, os.SEEK_END)
        if not guard.tell():
            guard.write(b'\0')
            guard.flush()
        guard.seek(0)
        msvcrt.locking(guard.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)


def acquire_profile(profile, proc_root=Path('/proc')):
    profile = Path(profile).resolve()
    profile.mkdir(parents=True, exist_ok=True)
    guard = (profile / '.provider.lock').open('a+b')
    try:
        lock_file(guard)
        if os.name == 'nt':
            # Chromium manages its own Windows singleton. Never delete its locks.
            return guard
        # Another live local browser must never have its singleton removed.
        for process in proc_root.iterdir() if proc_root.is_dir() else ():
            if not process.name.isdigit():
                continue
            try:
                args = (process / 'cmdline').read_bytes().split(b'\0')
            except (FileNotFoundError, PermissionError, ProcessLookupError):
                continue
            if os.fsencode(f'--user-data-dir={profile}') in args:
                raise RuntimeError('profile_browser_already_running')
        # This directory is an exclusive Docker volume for this Provider.
        # Chromium writes hostname/PID/socket symlinks which outlive a container.
        for name in ('SingletonLock', 'SingletonCookie', 'SingletonSocket'):
            entry = profile / name
            if entry.is_symlink():
                entry.unlink()
        return guard
    except BaseException:
        guard.close()
        raise
