"""Prepare a single complete official video, optionally compressing its copy.

No source/provider mutations, splitting, truncation, or QQ message retries.
The caller chooses the transport after preparation succeeds.
"""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import time

MAX_BYTES = 200_000_000
MAX_SOURCE_BYTES = 500 * 1024 * 1024
TARGET_BYTES = 190_000_000


class OfficialVideoPreparationError(ValueError):
    """Safe user-facing explanation of a failure before message submission."""


@dataclass
class PreparedVideo:
    path: Path
    size: int
    original_size: int
    expires_at: float
    users: int = 0


async def run_tool(arguments, timeout):
    try:
        process = await asyncio.create_subprocess_exec(
            *map(str, arguments), stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        raise OfficialVideoPreparationError('视频未发送：服务器缺少视频压缩工具。') from None
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout)
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.communicate()
        raise
    if process.returncode:
        raise OfficialVideoPreparationError('视频未发送：完整视频检查或压缩失败。')
    return stdout


async def probe(path, ffprobe, timeout=30):
    output = await run_tool([ffprobe, '-v', 'error', '-show_format', '-show_streams',
                             '-of', 'json', path], timeout)
    data = json.loads(output)
    duration = float(data.get('format', {}).get('duration') or 0)
    streams = data.get('streams') or []
    if not math.isfinite(duration) or duration <= 0 or not any(s.get('codec_type') == 'video' for s in streams):
        raise OfficialVideoPreparationError('视频未发送：无法确认完整视频时长。')
    return duration, any(s.get('codec_type') == 'audio' for s in streams)


def encoding_budget(duration, has_audio, target_bytes):
    budget = int(target_bytes * 8 / duration * 0.97)
    audio = min(128_000, max(32_000, budget // 6)) if has_audio else 0
    video = budget - audio
    if video < 48_000:
        raise OfficialVideoPreparationError('视频未发送：时长过长，无法在保留完整内容的情况下压到 200MB。')
    width, height = (640, 360) if video < 250_000 else (854, 480) if video < 700_000 else (1280, 720)
    return video, audio, width, height


async def compress_video(source, destination, *, ffmpeg, timeout=900,
                         maximum=MAX_BYTES, target_bytes=TARGET_BYTES):
    ffprobe = str(Path(ffmpeg).with_name('ffprobe.exe' if str(ffmpeg).lower().endswith('.exe') else 'ffprobe'))
    deadline = time.monotonic() + timeout
    def remaining():
        value = deadline - time.monotonic()
        if value <= 0:
            raise asyncio.TimeoutError()
        return value
    duration, has_audio = await probe(source, ffprobe, min(30, remaining()))
    video, audio, width, height = encoding_budget(duration, has_audio, min(target_bytes, int(maximum * 0.95)))
    scale = f'scale=w=min({width}\\,iw):h=min({height}\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2'
    with tempfile.TemporaryDirectory(prefix='encode-', dir=destination.parent) as directory:
        passlog = str(Path(directory) / 'pass')
        common = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                  '-i', source, '-map', '0:v:0', '-c:v', 'libx264', '-preset', 'veryfast',
                  '-threads', '2', '-pix_fmt', 'yuv420p', '-vf', scale,
                  '-b:v', str(video), '-passlogfile', passlog]
        # Two-pass bitrate control keeps the entire duration; never use -fs/-t.
        await run_tool([*common, '-pass', '1', '-an', '-f', 'null', os.devnull], remaining())
        audio_args = ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', str(audio)] if has_audio else ['-an']
        await run_tool([*common, '-pass', '2', *audio_args, '-movflags', '+faststart', destination], remaining())
    size = destination.stat().st_size
    output_duration, output_audio = await probe(destination, ffprobe, min(30, remaining()))
    if size <= 0 or size > maximum or abs(output_duration - duration) > max(2, duration * 0.01) or (has_audio and not output_audio):
        raise OfficialVideoPreparationError('视频未发送：压缩后大小或完整性检查未通过。')
    return size


class OfficialVideoCache:
    def __init__(self, directory=None, *, ttl=1800, max_cache_bytes=2 * 1024**3):
        self.directory = Path(directory or 'data/plugin_data/longtu_official_video')
        self.ttl = ttl
        self.max_cache_bytes = max_cache_bytes
        self.entries = {}
        self.locks = {}
        self.download_slots = asyncio.Semaphore(2)
        self.encode_slot = asyncio.Semaphore(1)

    def prune(self):
        # Windows may briefly retain an upload handle. Cache housekeeping must
        # never turn an already-sent message into an apparent delivery failure.
        try:
            self._prune()
        except OSError:
            pass

    def _prune(self):
        now = time.monotonic()
        for key, entry in list(self.entries.items()):
            if entry.expires_at <= now and not entry.users:
                self.entries.pop(key, None)
                entry.path.unlink(missing_ok=True)
        files = sorted(self.directory.glob('*.mp4'), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        active = {entry.path for entry in self.entries.values() if entry.users}
        for path in files:
            if path in active:
                continue
            if total > self.max_cache_bytes or time.time() - path.stat().st_mtime > self.ttl:
                total -= path.stat().st_size
                path.unlink(missing_ok=True)

    async def download(self, url, destination):
        import aiohttp
        async with self.download_slots, aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=480, connect=20, sock_read=90),
        ) as session:
            async with session.get(url) as response:
                response.raise_for_status()
                expected = int(response.headers.get('Content-Length') or 0)
                if expected > MAX_SOURCE_BYTES:
                    raise OfficialVideoPreparationError('视频未发送：原文件超过 500MiB 下载上限。')
                size = 0
                with destination.open('wb') as output:
                    async for chunk in response.content.iter_chunked(1024 * 1024):
                        size += len(chunk)
                        if size > MAX_SOURCE_BYTES:
                            raise OfficialVideoPreparationError('视频未发送：原文件超过 500MiB 下载上限。')
                        output.write(chunk)
                if not size or (expected and expected != size):
                    raise OfficialVideoPreparationError('视频未发送：完整文件下载校验失败。')
                return size

    @asynccontextmanager
    async def prepare(self, url, *, ffmpeg, timeout=900):
        self.directory.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha256(str(url).encode()).hexdigest()
        lock = self.locks.setdefault(key, asyncio.Lock())
        # Keep the file leased while the caller uploads it; cleanup cannot
        # remove a file still in use by another group.
        async with lock:
            self.prune()
            entry = self.entries.get(key)
            if entry is None or not entry.path.is_file():
                self.entries.pop(key, None)
                try:
                    with tempfile.TemporaryDirectory(prefix='prepare-', dir=self.directory) as directory:
                        source = Path(directory) / 'source.mp4'
                        size = await self.download(url, source)
                        output = source
                        if size > MAX_BYTES:
                            output = Path(directory) / 'compressed.mp4'
                            async with self.encode_slot:
                                await compress_video(source, output, ffmpeg=ffmpeg, timeout=timeout)
                        destination = self.directory / f'{key}.mp4'
                        output.replace(destination)
                        entry = PreparedVideo(destination, destination.stat().st_size, size,
                                              time.monotonic() + self.ttl)
                        self.entries[key] = entry
                except OfficialVideoPreparationError:
                    raise
                except asyncio.TimeoutError:
                    raise OfficialVideoPreparationError('视频未发送：完整文件下载或压缩超时，请稍后重试。') from None
                except (OSError, ValueError):
                    raise OfficialVideoPreparationError('视频未发送：完整文件准备失败。') from None
            entry.expires_at = time.monotonic() + self.ttl
            entry.users += 1
        try:
            yield entry
        finally:
            entry.users -= 1
            self.prune()
