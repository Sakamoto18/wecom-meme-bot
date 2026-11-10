"""Render library stickers at a bounded size without altering their pixels."""
import asyncio
import base64
import hashlib
import io
import secrets

import aiohttp
from PIL import Image, ImageOps
from botpy.http import Route
from astrbot.api import logger


def image_metadata(encoded, max_edge=200):
    data = base64.b64decode(encoded, validate=True)
    if len(data) > 10 * 1024 * 1024:
        raise ValueError('Image exceeds official material limit')
    with Image.open(io.BytesIO(data)) as image:
        fmt = image.format
        width, height = ImageOps.exif_transpose(image).size
    formats = {'PNG': ('png', 'image/png'), 'JPEG': ('jpg', 'image/jpeg'),
               'GIF': ('gif', 'image/gif'), 'WEBP': ('webp', 'image/webp')}
    extension, content_type = formats[fmt]
    scale = min(1, max_edge / max(width, height))
    return data, extension, content_type, max(1, round(width * scale)), max(1, round(height * scale))


async def upload_markdown_image(http, encoded, material_ids, max_edge=200):
    """Track each completed material before validation so callers can clean up."""
    data, ext, mime, width, height = await asyncio.to_thread(image_metadata, encoded, max_edge)
    md5 = hashlib.md5(data).hexdigest()
    prepared = await http.request(Route('POST', '/v2/media-images/prepare'), json={
        'file_name': f'longtu-{md5}.{ext}', 'file_size': len(data),
        'content_type': mime, 'md5': md5, 'sha1': hashlib.sha1(data).hexdigest(),
    })
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        async with session.put(prepared['presigned_url'], data=data,
                               headers={'Content-Type': mime}) as response:
            response.raise_for_status()
            etag = response.headers.get('ETag', md5).strip('"')
    material = await http.request(Route('POST', '/v2/media-images/complete'), json={
        'upload_id': prepared['upload_id'], 'md5': etag,
    })
    material_ids.append(material['image_id'])
    url = material['url']
    if not url.startswith('qqbot-media://image/') or any(c in url for c in '\n\r() '):
        raise ValueError('Invalid official image reference')
    return url, width, height


async def cleanup_materials(http, material_ids):
    for image_id in dict.fromkeys(material_ids):
        try:
            await asyncio.wait_for(http.request(
                Route('DELETE', '/v2/media-images/{image_id}/delete', image_id=image_id)), timeout=10)
        except Exception as error:
            logger.warning(f'官方临时图片素材清理失败：{type(error).__name__}')


async def send_markdown_images(event, content):
    if event.is_private_chat():
        route = Route('POST', '/v2/users/{openid}/messages', openid=event.get_sender_id())
    else:
        route = Route('POST', '/v2/groups/{group_openid}/messages', group_openid=event.get_group_id())
    result = await event.bot.api._http.request(route, json={
        'msg_type': 2, 'msg_id': str(event.message_obj.message_id),
        'msg_seq': 10001 + secrets.randbelow(10000),
        'markdown': {'content': content, 'force_verify_image_resource': True},
    })
    if not isinstance(result, dict) or not result.get('id'):
        raise RuntimeError('Official image message send was not confirmed')


async def send_compact_image(event, encoded):
    """False permits normal-image fallback only before any message is sent.

    Delete only the temporary material created here. Tencent transfers a copy
    when a message is accepted, so deleting it does not alter sent messages.
    Never retry an uncertain message send as a second normal image.
    """
    material_ids = []
    http = event.bot.api._http
    try:
        try:
            url, width, height = await upload_markdown_image(http, encoded, material_ids)
        except Exception as error:
            logger.warning(f'官方紧凑表情准备失败，回退普通图片：{type(error).__name__}')
            return False
        await send_markdown_images(event, f'![表情 #{width}px #{height}px]({url})')
        logger.info(f'官方紧凑表情发送完成：size={width}x{height}')
        return True
    finally:
        await cleanup_materials(http, material_ids)
