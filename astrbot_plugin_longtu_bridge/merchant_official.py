"""Official merchant delivery uses verified identities and retains API receipts."""
import asyncio
import base64
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


async def prepare_image(client, group, png):
    from astrbot.core.platform.sources.qqofficial.qqofficial_message_event import QQOfficialMessageEvent
    media = await asyncio.wait_for(QQOfficialMessageEvent.upload_group_and_c2c_image(
        SimpleNamespace(bot=client), base64.b64encode(png).decode(),
        QQOfficialMessageEvent.IMAGE_FILE_TYPE, group_openid=group), 45)
    if not media:
        raise RuntimeError('Official merchant image upload failed')
    return media


async def send_image(client, group, media, text, mentions=(), reply_id=''):
    if any(not valid_openid(oid) for oid in mentions):
        raise ValueError('Invalid official merchant mention')
    content = ''.join(f'<qqbot-at-user id="{oid}" />' for oid in mentions)
    content += ('\n' if mentions else '') + text
    payload = dict(group_openid=group, msg_type=7, content=content, media=media, msg_seq=1)
    if reply_id:
        payload['msg_id'] = reply_id
    result = await asyncio.wait_for(client.api.post_group_message(**payload), 30)
    receipt = message_id(result)
    if not receipt:
        raise RuntimeError('Official merchant send has no receipt; do not blindly retry')
    return receipt
