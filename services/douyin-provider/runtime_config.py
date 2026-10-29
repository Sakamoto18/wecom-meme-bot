"""Platform defaults; Linux containers keep their existing paths and flags."""
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def data_path(variable, linux_default, windows_relative):
    default = str(PROJECT_ROOT / 'data' / 'windows' / windows_relative) if sys.platform == 'win32' else linux_default
    return Path(os.getenv(variable) or default).resolve()


def douyin_profile_path():
    return data_path('DOUYIN_PROFILE', '/data/profile', 'douyin-profile')


def browser_options(cache=False):
    windows = sys.platform == 'win32'
    args = ['--disable-gpu'] if windows else ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    if cache:
        args.append('--disk-cache-size=67108864')
    options = dict(headless=False, timeout=10000, args=args)
    executable = os.getenv('MEDIA_BROWSER_EXECUTABLE', '').strip()
    channel = os.getenv('MEDIA_BROWSER_CHANNEL', '').strip()
    if executable:
        options['executable_path'] = executable
    elif channel:
        options['channel'] = channel
    elif windows:
        # Server 2022 has Edge; reuse the native browser, without Xvfb/WSL.
        options['channel'] = 'msedge'
    else:
        options['executable_path'] = '/usr/bin/chromium'
    return options
