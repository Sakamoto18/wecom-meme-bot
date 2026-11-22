"""Official merchant delivery uses verified identities and retains API receipts."""
import asyncio
import base64
from contextlib import asynccontextmanager
from dataclasses import dataclass
import html
import json
import re
from types import SimpleNamespace


def official_platform(bridge):
    appid = str(bridge.config.get('official_trial_appid') or '')
    manager = getattr(bridge.context, 'platform_manager', None)
    return next((p for p in getattr(manager, 'platform_insts', [])
                 if p.meta().name == 'qq_official' and str(getattr(p, 'appid', '')) == appid), None)


def bindings(value):
    data = json.loads(value or '{}') if isinstance(value, str) else value or {}
    if not isinstance(data, dict):
        raise ValueError('Invalid official identity mapping')
    return data


def valid_openid(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{8,128}', value) is not None


def scheduled_target(config, qq_group, mentions):
    """Never guess a group or user by display name or use raw QQ IDs as OpenIDs."""
    if config.get('merchant_official_enabled') is not True or config.get('official_trial_enabled') is not True:
        return None
    groups = bindings(config.get('official_trial_group_bindings'))
    targets = [oid for oid, row in groups.items() if isinstance(row, dict)
               and str(row.get('qq_group_id')) == qq_group and valid_openid(oid)]
    if len(targets) != 1:
        return None
    # Merchant-only member mappings are scoped by group and do not grant any
    # of the administrator privileges attached to global user bindings.
    scoped = bindings(config.get('merchant_official_member_bindings')).get(targets[0], {})
    if not isinstance(scoped, dict):
        return None
    members = []
    for qq in mentions:
        oid = scoped.get(qq)
        if not valid_openid(oid) or oid == qq:
            return None
        members.append(oid)
    if len(set(members)) != len(mentions):
        return None
    return targets[0], members


def message_id(result):
    value = result.get('id') if isinstance(result, dict) else getattr(result, 'id', None)
    return str(value or '')


async def group_bot_state(client, group):
    from botpy.http import Route
    return await client.api._http.request(
        Route('GET', '/v2/groups/{group_openid}/bot_state', group_openid=group))


async def proactive_allowed(client, group):
    """Do not consume a round's delivery record while the group disallows pushes."""
    state = await asyncio.wait_for(group_bot_state(client, group), 10)
    if not isinstance(state, dict) or type(state.get('allow_proactive_msg')) is not bool:
        raise RuntimeError('Official group push permission could not be verified')
    return state['allow_proactive_msg']


async def prepare_image(client, group, png):
    from astrbot.core.platform.sources.qqofficial.qqofficial_message_event import QQOfficialMessageEvent
    media = await asyncio.wait_for(QQOfficialMessageEvent.upload_group_and_c2c_image(
        SimpleNamespace(bot=client), base64.b64encode(png).decode(),
        QQOfficialMessageEvent.IMAGE_FILE_TYPE, group_openid=group), 45)
    if not media:
        raise RuntimeError('Official merchant image upload failed')
    return media


@dataclass(frozen=True)
class MentionImage:
    url: str
    width: int
    height: int


@asynccontextmanager
async def prepare_mention_image(client, png):
    """Prepare before claiming delivery; clean up on every exit, including expiry."""
    from .official_compact_image import upload_markdown_image, cleanup_materials
    material_ids = []
    http = client.api._http
    try:
        url, width, height = await asyncio.wait_for(upload_markdown_image(
            http, base64.b64encode(png).decode(), material_ids, max_edge=1080), 45)
        yield MentionImage(url, width, height)
    finally:
        # Tencent copies accepted message images; deleting our temporary material
        # does not change an already-sent message. Never send a fallback message.
        await cleanup_materials(http, material_ids)


def markdown_text(text):
    """Stock labels are literal text, never extra @ tags or Markdown links."""
    return re.sub(r'([\\`*_{}\[\]()#+.!|~-])', r'\\\1', html.escape(text, quote=False))


async def send_image(client, group, media, text, mentions=(), reply_id=''):
    if any(not valid_openid(oid) for oid in mentions):
        raise ValueError('Invalid official merchant mention')
    if mentions or isinstance(media, MentionImage):
        # Group member @ is supported only inside Markdown, not rich-media content.
        if (not isinstance(media, MentionImage)
                or not media.url.startswith('qqbot-media://image/')
                or any(c in media.url for c in '\n\r() ')
                or not (0 < media.width <= 1080 and 0 < media.height <= 1080)):
            raise ValueError('Official merchant mentions require a prepared Markdown image')
        content = ' '.join(f'<qqbot-at-user id="{oid}" />' for oid in mentions)
        content += ('\n' if mentions else '') + markdown_text(text)
        content += f'\n![远行商人库存 #{media.width}px #{media.height}px]({media.url})'
        payload = dict(group_openid=group, msg_type=2, msg_seq=1,
                       markdown={'content': content, 'force_verify_image_resource': True})
    else:
        payload = dict(group_openid=group, msg_type=7, content=text, media=media, msg_seq=1)
    if reply_id:
        payload['msg_id'] = reply_id
    result = await asyncio.wait_for(client.api.post_group_message(**payload), 30)
    receipt = message_id(result)
    if not receipt:
        raise RuntimeError('Official merchant send has no receipt; do not blindly retry')
    return receipt
