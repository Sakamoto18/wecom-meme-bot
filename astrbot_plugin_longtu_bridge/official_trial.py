"""Opt-in official QQ trial using AstrBot's installed official transport.

Shared Node personality/gallery, isolated OpenID memory, no OneBot API calls.
Disable the platform or official_trial_enabled to immediately stop this entry.
"""
import asyncio
import base64
import hashlib
import json
import re
import tempfile
from pathlib import Path
from datetime import datetime, timedelta
import time

import astrbot.api.message_components as Comp
from astrbot.api import logger
from astrbot.api.event import MessageChain


def identity(appid, kind, value):
    if not value:
        return ''
    value = str(value)
    if len(value) > 80:
        value = hashlib.sha256(value.encode()).hexdigest()
    return f'qqofficial:{appid}:{kind}:{value}'


def enabled(config):
    return config.get('official_trial_enabled', False) is True


def user_bindings(config):
    raw = config.get('official_trial_user_bindings') or '{}'
    data = json.loads(raw) if isinstance(raw, str) else raw
    return data if isinstance(data, dict) else {}


def group_binding(config, group_id):
    prefix = f'qqofficial:{config.get("official_trial_appid")}:group:'
    if not str(group_id).startswith(prefix):
        return None
    raw = config.get('official_trial_group_bindings') or '{}'
    data = json.loads(raw) if isinstance(raw, str) else raw
    value = data.get(str(group_id)[len(prefix):], {}) if isinstance(data, dict) else {}
    return value if isinstance(value, dict) else {}


async def official_group_names(bridge, group_ids):
    names = {}
    for group_id in group_ids[:20]:
        binding = group_binding(bridge.config, group_id)
        if binding is None:
            continue
        qq = str(binding.get('qq_group_id') or '')
        name = str(binding.get('name') or '')
        if qq.isdigit():
            found = await bridge._group_names([qq])
            name = found.get(qq) or name
        names[str(group_id)] = name or (f'QQ群 {qq}' if qq else '官方 QQ 群')
    return names


def media_segments(raw):
    """Preserve URLs buried in official ark/msg_elements without identity data."""
    data = getattr(raw, 'raw_data', {})
    urls = []
    def walk(value, depth=0):
        if depth > 12 or len(urls) >= 24:
            return
        if isinstance(value, str):
            if len(value) > 256 * 1024:
                return
            if value.lstrip().startswith(('{', '[')):
                try:
                    walk(json.loads(value), depth + 1)
                    return
                except ValueError:
                    pass
            for url in re.findall(r'https?://[^\s<>"\x27]+', value.replace('\\/', '/')):
                if url not in urls:
                    urls.append(url[:4096])
        elif isinstance(value, dict):
            for key, item in value.items():
                if key not in ('author', 'mentions', 'avatar'):
                    walk(item, depth + 1)
        elif isinstance(value, list):
            for item in value[:32]:
                walk(item, depth + 1)
    walk(data)
    return [{'type': 'json', 'data': {'url': url}} for url in urls[:24]]


def quote_context(components, raw):
    """Read only the quote actually supplied by QQ; never claim a full history fetch."""
    quoted = next((c for c in components if isinstance(c, Comp.Reply)), None)
    chain = getattr(quoted, 'chain', None) or []
    text = ''.join(c.text for c in chain if isinstance(c, Comp.Plain))
    text = text or str(getattr(quoted, 'message_str', '') or getattr(quoted, 'text', '') or '')
    ref = getattr(raw, 'message_reference', None)
    message_id = str(getattr(quoted, 'id', '') or
                     (ref.get('message_id') if isinstance(ref, dict) else getattr(ref, 'message_id', '')) or '')
    raw_data = getattr(raw, 'raw_data', {}) or {}
    elements = getattr(raw, 'msg_elements', None) or raw_data.get('msg_elements', [])
    kind = str(getattr(raw, 'message_type', '') or raw_data.get('message_type', ''))
    author_id = author_name = ''
    if kind == '103' and elements and isinstance(elements[0], dict):
        row = elements[0]
        text = text or str(row.get('content') or '')
        message_id = message_id or str(row.get('id') or row.get('message_id') or '')
        author = row.get('author') or {}
        if isinstance(author, dict):
            author_id = str(author.get('member_openid') or author.get('user_openid') or author.get('id') or '')
            author_name = str(author.get('username') or '')
    return {'present': bool(quoted is not None or message_id or text or kind == '103'),
            'chain': chain, 'text': text, 'id': message_id,
            'author_id': author_id, 'author_name': author_name}


def output_chains(response, max_messages=5, truncation_notice=True):
    """Keep backend text bubbles separate, merging overflow within reply budget."""
    rows = response.get('messages') or []
    texts = [str(row['text']) for row in rows if row.get('type') == 'text' and row.get('text')]
    media = []
    for row in rows:
        kind = row.get('type')
        if kind == 'image':
            source = 'base64://' + row['base64'] if row.get('base64') else row.get('url')
            if source:
                media.append(Comp.Image(file=source))
        elif kind == 'forward':
            media.extend(Comp.Image(file=url) for url in row.get('images', [])
                         if isinstance(url, str) and url.startswith(('https://', 'http://')))
        elif kind == 'video':
            url = row.get('url')
            if url and str(url).startswith(('https://', 'http://')):
                media.append(Comp.Video(file=url))
    reserve = 1 if texts else 0
    if truncation_notice and len(media) > max_messages - reserve:
        texts.append('本次图片较多，先发送前几张。')
        reserve = 1
    chains = []
    if texts:
        text_slots = max(1, max_messages - len(media))
        if len(texts) > text_slots:
            texts = texts[:text_slots - 1] + ['\n'.join(texts[text_slots - 1:])]
        chains.extend(MessageChain([Comp.Plain(text[:3500])]) for text in texts)
        reserve = len(texts)
    chains.extend(MessageChain([item]) for item in media[:max_messages - reserve])
    for chain in chains:
        chain.use_markdown_ = False
    return chains


async def send_chain(bridge, event, chain):
    """Upload backend video locally: Tencent cannot fetch loopback media URLs."""
    import aiohttp
    video = next((c for c in chain.chain if isinstance(c, Comp.Video)), None)
    if video is None:
        await event.send(chain)
        logger.info('官方 QQ 发送完成：kind=' + ('image' if any(isinstance(c, Comp.Image) for c in chain.chain) else 'text'))
        return
    maximum = 200 * 1024 * 1024
    with tempfile.TemporaryDirectory(prefix='longtu-official-video-') as directory:
        path = Path(directory) / 'video.mp4'
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=480)) as session:
            async with session.get(str(video.file)) as response:
                response.raise_for_status()
                if int(response.headers.get('Content-Length') or 0) > maximum:
                    raise ValueError('视频超过官方 200MB 上限')
                total = 0
                with path.open('wb') as output:
                    async for chunk in response.content.iter_chunked(1024 * 1024):
                        total += len(chunk)
                        if total > maximum:
                            raise ValueError('视频超过官方 200MB 上限')
                        output.write(chunk)
        video.file = str(path)
        await event.send(chain)
        logger.info(f'官方 QQ 视频发送完成：bytes={total}')


async def report_chains(bridge, report_date, *, end_at=None, requested_by=''):
    from .usage_report_card import render_usage_report
    body, text = await bridge._prepare_usage_report(report_date, end_at=end_at, requested_by=requested_by)
    try:
        names = await bridge._group_catalog()
        missing = [str(row['groupId']) for row in body['report'].get('groups', []) if str(row['groupId']) not in names]
        names.update(await bridge._group_names(missing))
        pngs = await asyncio.to_thread(render_usage_report, body['report'], names)
        if not pngs:
            raise ValueError('日报没有图片')
        return [MessageChain([Comp.Image.fromBase64(base64.b64encode(png).decode())]) for png in pngs]
    except Exception as error:
        logger.warning(f'官方日报图片生成失败：{type(error).__name__}')
        return [MessageChain([Comp.Plain(text)])]


async def proactive(bridge, target, chains, *, group=False):
    platform = next((p for p in bridge.context.platform_manager.platform_insts
                     if p.meta().name == 'qq_official' and str(getattr(p, 'appid', ''))
                     == str(bridge.config.get('official_trial_appid'))), None)
    if not platform or not enabled(bridge.config):
        return False
    platform.remember_session_scene(target, 'group' if group else 'friend')
    for chain in chains:
        chain.use_markdown_ = False
        ok = await bridge.context.send_message(
            f'{platform.meta().id}:{"GroupMessage" if group else "FriendMessage"}:{target}', chain)
        if not ok:
            return False
    return True


async def mirror_daily_report(bridge, report_date):
    if not enabled(bridge.config) or not bridge.config.get('official_trial_push_enabled', False):
        return
    for openid, qq in user_bindings(bridge.config).items():
        try:
            chains = await report_chains(bridge, report_date, requested_by=str(qq))
            await proactive(bridge, openid, chains)
        except Exception as error:
            logger.warning(f'官方定时日报失败：{type(error).__name__}')


async def mirror_crazy_thursday(bridge, target_date):
    if not enabled(bridge.config) or not bridge.config.get('official_trial_push_enabled', False):
        return
    groups = [x.strip() for x in str(bridge.config.get('official_trial_push_groups') or '').split(',') if x.strip()]
    if not groups:
        return
    text = await bridge._generate_crazy_thursday_text(target_date, scheduled=True)
    for group in groups:
        try:
            await proactive(bridge, group, [MessageChain([Comp.Plain(text)])], group=True)
        except Exception as error:
            logger.warning(f'官方星期四推送失败：{type(error).__name__}')


async def mirror_learning(bridge, payload):
    """Deliver official-targeted jobs, or mirror configured administrator reports."""
    if not enabled(bridge.config):
        return None
    appid = str(bridge.config.get('official_trial_appid'))
    prefix = f'qqofficial:{appid}:'
    group = payload.get('chatType') == 'group'
    target = str(payload.get('groupId') if group else payload.get('userId') or '')
    own = target.startswith(prefix)
    targets = [target.split(':', 3)[-1]] if own else []
    if not own and not group and bridge.config.get('official_trial_push_enabled', False):
        targets = [key for key, qq in user_bindings(bridge.config).items() if str(qq) == target]
    if not targets:
        return None
    chains = [MessageChain([Comp.Plain(str(payload.get('text') or ''))])]
    if payload.get('reportImage') and str(payload.get('imageFile') or '').startswith('base64://'):
        chains.append(MessageChain([Comp.Image(file=payload['imageFile'])]))
    ok = True
    for target in targets:
        try:
            ok = await proactive(bridge, target, chains, group=group) and ok
        except Exception as error:
            logger.warning(f'官方学习投递失败：{type(error).__name__}')
            ok = False
    return ok if own else None


async def handle_official_message(bridge, event):
    # Dedicated entry must never fall through to a second LLM/personality.
    event.call_llm = True
    media_receipt = False
    media_stage = 'backend'
    observe_only = False
    try:
        if not enabled(bridge.config):
            return
        configured_app = str(bridge.config.get('official_trial_appid') or '').strip()
        platform = getattr(getattr(event, 'bot', None), 'platform', None)
        appid = str(getattr(platform, 'appid', '') or '')
        if not configured_app or appid != configured_app:
            return
        raw = getattr(event.message_obj, 'raw_message', None)
        # Trial only handles QQ groups and C2C, not guild/channel identities.
        if not (getattr(raw, 'group_openid', None) or getattr(raw, 'author', None)
                and getattr(raw.author, 'user_openid', None)):
            return
        components = event.get_messages() or []
        private = event.is_private_chat()
        mentioned = any(isinstance(c, Comp.At) and str(c.qq) == str(event.get_self_id())
                        for c in components)
        allowed = {x.strip() for x in str(bridge.config.get('official_trial_groups') or '').split(',') if x.strip()}
        if not private and allowed and str(event.get_group_id()) not in allowed:
            return
        message_id = str(event.message_obj.message_id or '')
        if not message_id:
            return
        seen = getattr(bridge, '_official_trial_seen', None)
        if seen is None:
            seen = bridge._official_trial_seen = {}
        key = (appid, str(event.get_group_id()), message_id)
        now = time.monotonic()
        if key in seen and seen[key] > now - 600:
            return
        seen[key] = now
        if len(seen) > 2000:
            for old in sorted(seen, key=seen.get)[:1000]:
                del seen[old]
        text = ''.join(c.text for c in components if isinstance(c, Comp.Plain)).strip()
        # WakingCheck may strip a slash from the component; raw content is authoritative.
        raw_text = str(getattr(raw, 'content', '') or '').strip()
        if raw_text.startswith('/'):
            text = raw_text
        bound_user = str(user_bindings(bridge.config).get(str(event.get_sender_id())) or '')
        from .main import ALLOWED_BRIDGE_SLASH_COMMANDS, REPORT_TIMEZONE, nearby_holiday_context, MEDIA_ACK_PATTERN
        rich = media_segments(raw)
        quote = quote_context(components, raw)
        # Full group messages feed the existing backend's passive decision gate.
        # A shared URL is a direct share; other chatter is observation only.
        # Never feed this bot's own output or another bot back into the loop.
        if not private and (getattr(getattr(raw, 'author', None), 'bot', False)
                            or str(event.get_sender_id()) == str(event.get_self_id())):
            return
        has_link = bool(re.search(r'https?://', text, re.IGNORECASE)
                        or MEDIA_ACK_PATTERN.search(str(rich)))
        quoted_bot = bool(quote['author_id'] and quote['author_id'] == str(event.get_self_id()))
        observe_only = bool(not private and not mentioned and not quoted_bot and not has_link)
        if observe_only and text.startswith('/'):
            return
        if text.startswith('/') and text.split()[0] not in ALLOWED_BRIDGE_SLASH_COMMANDS:
            return
        if text.split(' ', 1)[0] == '/usage-report':
            if not bound_user:
                await event.send(MessageChain([Comp.Plain('请在已绑定管理员的官方私聊中查询日报。')]))
                return
            argument = text[len('/usage-report'):].strip()
            if argument:
                day, end_at = bridge._usage_report_period(argument)
            else:
                now = datetime.now(REPORT_TIMEZONE)
                day, end_at = now.date(), now + timedelta(milliseconds=1)
            chains = await report_chains(bridge, day, end_at=end_at, requested_by=bound_user)
            if not private:
                recipient = next((openid for openid, qq in user_bindings(bridge.config).items()
                                  if str(qq) == bound_user), '')
                if not recipient or not await proactive(bridge, recipient, chains):
                    raise ValueError('日报私聊投递失败，请到官方机器人私聊重试 /usage-report。')
                await event.send(MessageChain([Comp.Plain('日报已发送到你的官方机器人私聊。')]))
                return
            for chain in chains:
                chain.use_markdown_ = False
                await send_chain(bridge, event, chain)
            return
        importing = bool(bound_user and (text.startswith('/rel-import') or
                         getattr(bridge, '_relation_import_active', lambda e: False)(event)))
        images = await bridge._image_base64s(components, limit=24 if importing else 8)
        quote_chain = quote['chain']
        quote_images = await bridge._image_base64s(quote_chain, limit=24 if importing else 4)
        quoted_record = '[群聊的聊天记录]' in quote['text'] or '=== 消息 ' in quote['text']
        pure_mention = bool(mentioned and not text and not images and not quote['present'])
        current_text = text
        if not current_text and quote['present']:
            current_text = '请回应我引用的这条消息。' if quote['text'] or quote_images else '我引用了一条消息，但本次没有附带可读正文。'
        elif pure_mention:
            current_text = '叫我有事？'
        payload = {
            'message_id': identity(appid, 'message', message_id),
            'message_type': 'private' if private else 'group',
            'group_id': '' if private else identity(appid, 'group', event.get_group_id()),
            'user_id': bound_user or identity(appid, 'user', event.get_sender_id()),
            'sender_name': event.get_sender_name(),
            'bot_user_id': identity(appid, 'user', event.get_self_id()),
            'text': current_text,
            'pure_bot_mention': pure_mention,
            'mentions': [{'user_id': identity(appid, 'user', c.qq), 'name': getattr(c, 'name', '')}
                         for c in components if isinstance(c, Comp.At)],
            'has_image': bool(images or quote_images), 'image_base64s': images,
            'quoted_image_base64s': quote_images,
            'quoted_text': '' if quoted_record else quote['text'],
            'quoted_forwarded_text': quote['text'] if quoted_record else '',
            'quoted_message_id': identity(appid, 'message', quote['id']),
            'quoted_user_id': (str(user_bindings(bridge.config).get(quote['author_id']) or '')
                               or identity(appid, 'user', quote['author_id'])),
            'quoted_sender_name': quote['author_name'],
            'rich_segments': rich,
            'media_share': True,
            'observe_only': observe_only,
        }
        if text.startswith('/crazy-thursday'):
            if not private:
                return
            command, _, argument = text.partition(' ')
            payload.update(text='', crazy_thursday_request=True,
                           crazy_thursday_date=datetime.now(REPORT_TIMEZONE).date().isoformat(),
                           crazy_thursday_holiday_context=nearby_holiday_context(datetime.now(REPORT_TIMEZONE).date()))
            if command == '/crazy-thursday': payload['crazy_thursday_test'] = True
            elif command == '/crazy-thursday-add': payload.update(crazy_thursday_add=True, crazy_thursday_entry=argument)
            elif command == '/crazy-thursday-list': payload['crazy_thursday_list'] = True
            elif command == '/crazy-thursday-del': payload['crazy_thursday_delete'] = argument
        logger.info(f'官方 QQ 试用收到消息：appid={appid} private={private} group={event.get_group_id()} '
                    f'images={len(images)} observe={observe_only} link={has_link} '
                    f'quote={quote["present"]} quote_chars={len(quote["text"])}')
        media_receipt = bool(not text.startswith('/') and MEDIA_ACK_PATTERN.search(text + ' ' + str(rich)))
        from .web_learning_progress import request_learning_backend
        response = await request_learning_backend(bridge, event, payload)
        update = getattr(bridge, '_update_relation_import', None)
        if callable(update):
            update(event, response)
        logger.info(f'官方后端结果：mode={response.get("mode")} types={[row.get("type") for row in response.get("messages", [])]}')
        if media_receipt and response.get('mode') in ('media-unavailable', 'media-disabled', 'media-excluded'):
            notices = {'media-unavailable': '抓取失败：暂时无法获取这个分享，请检查链接或稍后重试。',
                       'media-disabled': '未抓取：媒体解析服务当前未启用。',
                       'media-excluded': '未抓取：当前群未开启这个来源的解析。'}
            detail = '\n'.join(str(row.get('text') or '') for row in response.get('messages', [])
                               if row.get('type') == 'text').strip()
            notice = MessageChain([Comp.Plain(notices[response['mode']] + ('\n' + detail[:600] if detail else ''))])
            notice.use_markdown_ = False
            await event.send(notice)
            return
        from .web_learning_progress import deliver_learning_report
        if await deliver_learning_report(event, response):
            return
        media = next((row for row in response.get('messages', []) if row.get('type') in ('video', 'forward')), None)
        result_media_count = sum(1 if row.get('type') in ('video', 'image') else len(row.get('images', []))
                                 if row.get('type') == 'forward' else 0 for row in response.get('messages', []))
        card = ''
        if media and (not media_receipt or media.get('type') == 'forward'
                      or media.get('type') == 'video' and result_media_count == 1):
            try:
                card = await asyncio.wait_for(bridge._video_card(media), timeout=12)
            except Exception as error:
                logger.warning(f'官方分享简介卡生成失败：{type(error).__name__}')
                card = ''
            if media.get('type') == 'forward':
                from .official_gallery import send_gallery, GalleryPreparationError
                galleries = [row for row in response['messages'] if row.get('type') == 'forward']
                media_stage = 'send'
                if card:
                    await send_chain(bridge, event, output_chains(
                        {'messages': [{'type': 'image', 'base64': card}]})[0])
                try:
                    await send_gallery(event, bridge, galleries)
                except GalleryPreparationError as error:
                    notice = MessageChain([Comp.Plain(str(error))])
                    notice.use_markdown_ = False
                    await event.send(notice)
                return
            if card:
                response = {**response, 'messages': [{'type': 'image', 'base64': card}, *response['messages']]}
        # Tencent permits 4 C2C / 5 group passive replies. Keep a slot for
        # an uncertain/partial upload failure. Successful sends stay silent.
        budget = (4 if private else 5) - (1 if media_receipt else 0)
        chains = output_chains(response, max_messages=budget, truncation_notice=not media_receipt)
        stickers = {'base64://' + row['base64']: row['base64']
                    for row in response.get('messages', [])
                    if row.get('type') == 'image' and row.get('sub_type') == 1 and row.get('base64')}
        media_stage = 'send'
        for chain in chains:
            component = chain.chain[0] if len(chain.chain) == 1 else None
            if isinstance(component, Comp.Image) and component.file in stickers:
                from .official_compact_image import send_compact_image
                if await send_compact_image(event, stickers[component.file]):
                    continue
            await send_chain(bridge, event, chain)
        if media_receipt:
            status = ''
            if result_media_count:
                delivered = sum(isinstance(c, (Comp.Image, Comp.Video)) for chain in chains for c in chain.chain)
                expected = result_media_count + bool(media and card)
                if delivered < expected:
                    status = '内容未全部发送：达到官方单条回复数量限制。'
            elif not chains:
                status = '抓取失败：未返回可发送的内容，请稍后重试。'
            if status:
                receipt = MessageChain([Comp.Plain(status)])
                receipt.use_markdown_ = False
                await event.send(receipt)
        logger.info(f'官方 QQ 试用回复完成：appid={appid}')
    except Exception as error:
        # Unknown sends must not be blindly retried by this bridge.
        logger.warning(f'官方 QQ 试用失败：{type(error).__name__} code={getattr(error, "code", "")}')
        if observe_only:
            return
        if media_receipt:
            if media_stage == 'send':
                status = '解析已完成，但内容未全部确认发送；可能已有部分到达，请勿连续重复提交。'
            elif isinstance(error, asyncio.TimeoutError):
                status = '抓取等待超时，暂未拿到结果，请稍后重试。'
            else:
                status = '分享处理失败，未能完成抓取或发送，请稍后重试。'
            try:
                receipt = MessageChain([Comp.Plain(status)])
                receipt.use_markdown_ = False
                await event.send(receipt)
            except Exception:
                logger.warning('官方分享失败回执也未能发送')
        elif isinstance(error, (ValueError, PermissionError)):
            await event.send(MessageChain([Comp.Plain(str(error)[:300])]))
        elif not isinstance(error, asyncio.TimeoutError):
            try:
                await event.send(MessageChain([Comp.Plain('本次官方接口处理失败，已记录排查；原 QQ 机器人仍可使用。')]))
            except Exception:
                pass
    finally:
        event.stop_event()
