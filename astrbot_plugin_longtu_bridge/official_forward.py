"""Read image attachments in QQ's supplied merged-record text, without history APIs."""
import asyncio
import base64
import re
from urllib.parse import urlsplit, urlunsplit

HEADER = '[群聊的聊天记录]'
NODE = re.compile(r'^(?:=== 消息 \d+ ===|--- 第\d+条 ---)\s*$')
IMAGE = re.compile(r'^\[附件\d+\]\s+类型:图片(?:\s|$)')
URL = re.compile(r'\s+URL:(https?://\S+)')
HOSTS = {'multimedia.nt.qq.com.cn', 'gchat.qpic.cn', 'c2cpicdw.qpic.cn', 'qq.ugcimg.cn'}
MAX_IMAGES = 24
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 30 * 1024 * 1024


def image_url(value):
    try:
        url = urlsplit(value)
        if (url.scheme not in ('http', 'https') or url.hostname not in HOSTS
                or url.username or url.password or url.port not in (None, 80, 443)):
            return ''
        return urlunsplit(('https', url.hostname, url.path, url.query, ''))
    except ValueError:
        return ''


def parse_record(text):
    """Recognize the observed protocol envelope, not natural-language intent."""
    text = str(text or '')
    before, marker, body = text.partition(HEADER)
    if not marker or len(text) > 256 * 1024:
        return None
    # QQ quotes wrap a record in "[消息内容] [群聊的聊天记录]"
    # and format its associated nodes as "--- 第N条 ---".
    # Keep the protocol wrapper with the record, never as the user's request.
    prefix = before.splitlines()
    wrapper_start = next((i for i, line in enumerate(prefix)
                          if NODE.fullmatch(line.strip())), None)
    wrapper = []
    if wrapper_start is not None and before.rstrip().endswith('[消息内容]'):
        wrapper = prefix[wrapper_start:-1]
        before = '\n'.join(prefix[:wrapper_start])
    lines = wrapper + body.strip().splitlines()
    if not any(NODE.fullmatch(line.strip()) for line in lines):
        return None
    output, attachments = [HEADER], []
    nodes = characters = 0
    for line in lines:
        line = line.strip()
        if NODE.fullmatch(line):
            nodes += 1
        if nodes > 80 or characters + len(line) > 16000:
            output.append('（记录超过读取上限，后续内容未读取）')
            break
        # URL signatures are transport data, not text for the model/web search.
        matched = URL.search(line) if IMAGE.match(line) else None
        if IMAGE.match(line):
            attachments.append({'line': len(output), 'url': image_url(matched.group(1)) if matched else ''})
            line = URL.sub('', line) + ' [图片待读取]'
        elif line.startswith('[附件'):
            line = URL.sub('', line)
        output.append(line)
        characters += len(line)
    return {'text': before.strip(), 'lines': output, 'attachments': attachments}


def is_image(body):
    return (body.startswith(b'\x89PNG\r\n\x1a\n') or body.startswith(b'\xff\xd8\xff')
            or body.startswith((b'GIF87a', b'GIF89a'))
            or body[:4] == b'RIFF' and body[8:12] == b'WEBP')


async def download_image(session, url):
    if not url or not session or session.closed:
        return b''
    import aiohttp
    async with session.get(url, allow_redirects=False,
                           timeout=aiohttp.ClientTimeout(total=15)) as response:
        if response.status != 200 or (response.content_length or 0) > MAX_IMAGE_BYTES:
            return b''
        body = bytearray()
        async for chunk in response.content.iter_chunked(64 * 1024):
            body.extend(chunk)
            if len(body) > MAX_IMAGE_BYTES:
                return b''
        return bytes(body) if is_image(body) else b''


async def read_record(record, session, *, downloader=download_image):
    """Keep node/image ordering and mark every failed or omitted image explicitly."""
    if record is None:
        return '', []
    lines = list(record['lines'])
    attachments = record['attachments']
    slots = asyncio.Semaphore(3)
    async def fetch(row):
        if not row['url']:
            return b''
        async with slots:
            try:
                return await downloader(session, row['url'])
            except (OSError, ValueError, asyncio.TimeoutError):
                return b''
            except Exception:
                # Preserve readable nodes on a per-attachment transport error.
                return b''
    tasks = [asyncio.create_task(fetch(row)) for row in attachments[:MAX_IMAGES]]
    if tasks:
        try:
            await asyncio.wait(tasks, timeout=45)
        finally:
            pending = [task for task in tasks if not task.done()]
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
    images, total = [], 0
    for i, row in enumerate(attachments):
        body = tasks[i].result() if i < len(tasks) and not tasks[i].cancelled() else b''
        if body and total + len(body) <= MAX_TOTAL_BYTES:
            total += len(body)
            images.append(base64.b64encode(body).decode('ascii'))
            label = f'[图片#{len(images)}]'
        else:
            label = '[图片未读取：地址不可用、下载失败或超过读取上限，不能推断图中内容]'
        lines[row['line']] = lines[row['line']].replace('[图片待读取]', label)
    return '\n'.join(lines), images
