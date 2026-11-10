"""Deliver an entire gallery in one official QQ Markdown message."""
import asyncio
import base64
import re

from astrbot.api import logger
from .official_compact_image import upload_markdown_image, cleanup_materials, send_markdown_images


class GalleryPreparationError(ValueError):
    """Nothing was sent; a single failure notice is safe."""


def plain_markdown(value):
    # Source descriptions are text, never arbitrary Markdown image/link syntax.
    return re.sub(r'([\\`*_{}\[\]()<>#+.!|~>-])', r'\\\1', str(value or ''))


async def send_gallery(event, bridge, galleries):
    """Prepare every image before sending. Never fall back to a partial gallery."""
    http = event.bot.api._http
    material_ids = []
    parts = []
    count = sum(len(row.get('images') or []) for row in galleries)
    if not count:
        raise GalleryPreparationError('图集没有可发送的图片。')
    try:
        try:
            # A group passive reply expires after five minutes. Bound preparation
            # separately from the send so a timeout here is known not to have sent.
            async with asyncio.timeout(180):
                for gallery in galleries:
                    for key in ('title', 'author', 'description'):
                        if gallery.get(key):
                            parts.append(plain_markdown(gallery[key]))
                    for index, source in enumerate(gallery.get('images') or [], 1):
                        if not isinstance(source, str) or not source.startswith(('http://', 'https://')):
                            raise ValueError('Invalid gallery image URL')
                        data = await bridge._cover_bytes(source, gallery, label='官方图集原图')
                        if not data:
                            raise ValueError('Gallery image download failed')
                        url, width, height = await upload_markdown_image(
                            http, base64.b64encode(data).decode('ascii'), material_ids, max_edge=480)
                        parts.append(f'![原图{index} #{width}px #{height}px]({url})')
        except Exception as error:
            logger.warning(f'官方单条图集准备失败：images={count} error={type(error).__name__}')
            raise GalleryPreparationError('图集准备失败，未能完整获取或上传全部图片，本次未发送图集，请稍后重试。') from error
        await send_markdown_images(event, '\n\n'.join(parts))
        logger.info(f'官方单条图集发送完成：images={count} intro=False messages=1')
    finally:
        await cleanup_materials(http, material_ids)
