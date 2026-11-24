"""Opt-in official QQ trial using AstrBot's installed official transport.

Shared Node personality/gallery, isolated OpenID memory, no OneBot API calls.
Disable the platform or official_trial_enabled to immediately stop this entry.
"""
import asyncio
import base64
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from datetime import datetime, timedelta
import time
import traceback

import astrbot.api.message_components as Comp
from astrbot.api import logger
from astrbot.api.event import MessageChain
from .official_groups import official_group_names
from .official_policy import event_enabled, group_enabled
from .official_video import OfficialVideoCache, OfficialVideoPreparationError


MAX_OFFICIAL_MEDIA_BYTES = 200_000_000


class OfficialMediaTooLarge(OfficialVideoPreparationError):
    """A definite rejection before a video/file message is sent."""

    def __init__(self, size=0):
        self.size = size
        detail = f'（{size / 1_000_000:.1f}MB）' if size else ''
        super().__init__(f'视频{detail}未发送：超过 QQ 官方 200MB 上限，改成文件也受此限制。')


def error_diagnostics(error):
    """Keep error chains/locations without logging tokens, URLs or message bodies."""
    result, seen = [], set()
    while error is not None and id(error) not in seen and len(result) < 6:
        seen.add(id(error))
        row = {'type': type(error).__name__, 'frames': [
            {'file': frame.filename.replace('\\', '/').rsplit('/', 1)[-1],
             'line': frame.lineno, 'function': frame.name}
            for frame in traceback.extract_tb(error.__traceback__)[-12:]
        ]}
        for name in ('errno', 'winerror', 'code', 'status'):
            value = getattr(error, name, None)
            if isinstance(value, int) or isinstance(value, str) and re.fullmatch(r'[0-9]{1,12}', value):
                row[name] = value
        result.append(row)
        error = error.__cause__ or error.__context__
    return result


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


def media_segments(raw):
    from .official_media import extract_official_media
    return extract_official_media(raw)['segments']


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


def output_chains(response, max_messages=5, truncation_notice=True, *, official_video_url=False):
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
            # The Node resolver may expose a separate HTTPS origin whose
            # endpoint waits for the complete local file. Keep the normal URL
            # as fallback so the feature remains fully backward compatible.
            url = (row.get('officialUrl') if official_video_url else None) or row.get('url')
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


def _result_value(result, name, default=None):
    if isinstance(result, dict):
        return result.get(name, default)
    return getattr(result, name, default)


def _internal_media_ready_url(bridge, public_url):
    """Map the public media URL to the Node service reachable by AstrBot.

    The readiness probe must not depend on the public DNS/HTTPS round trip:
    AstrBot and Node already share an internal URL in ``api_url``. QQ still
    receives the public URL after this local probe succeeds.
    """
    match = re.search(r'/v1/qq/media/([A-Za-z0-9_-]+)(?:\?|$)', str(public_url or ''))
    if not match:
        return ''
    api_url_getter = getattr(bridge, '_api_url', None)
    if not callable(api_url_getter):
        return ''
    try:
        api_url = str(api_url_getter() or '').rstrip('/')
    except Exception:
        return ''
    suffix = '/v1/qq/message'
    if not api_url.endswith(suffix):
        return ''
    base = api_url[:-len(suffix)].rstrip('/')
    return f'{base}/v1/qq/media/{match.group(1)}?complete=1'


async def _wait_for_official_media_ready(bridge, public_url):
    """Wait for Node's complete local file before QQ fetches the public URL."""
    ready_url = _internal_media_ready_url(bridge, public_url)
    if not ready_url:
        return
    import aiohttp
    configured = (getattr(bridge, 'config', None) or {}).get(
        'official_video_ready_timeout_seconds', 150,
    )
    try:
        timeout_seconds = max(15, min(180, int(configured)))
    except (TypeError, ValueError):
        timeout_seconds = 150
    timeout = aiohttp.ClientTimeout(
        total=timeout_seconds, connect=10, sock_read=timeout_seconds,
    )
    last_status = None
    async with aiohttp.ClientSession(timeout=timeout) as session:
        for attempt in range(2):
            try:
                async with session.head(ready_url, allow_redirects=False) as response:
                    last_status = response.status
                    if response.status == 200:
                        if int(response.headers.get('Content-Length') or 0) <= 0:
                            raise RuntimeError('官方视频完整文件预检返回空文件')
                        size = int(response.headers.get('Content-Length') or 0)
                        if size > MAX_OFFICIAL_MEDIA_BYTES:
                            raise OfficialMediaTooLarge(size)
                        return size
                    if response.status == 413:
                        raise OfficialMediaTooLarge()
            except (asyncio.CancelledError, ValueError):
                raise
            except Exception:
                if attempt == 1:
                    raise RuntimeError('官方视频完整文件预检失败') from None
            if attempt == 0:
                await asyncio.sleep(1)
    raise RuntimeError(f'官方视频完整文件预检失败：HTTP {last_status or "unknown"}')


async def send_official_video_url(bridge, event, url, *, reply_id=''):
    """Transfer a completed public MP4 through QQ's URL media API.

    This intentionally never falls back to ``event.send(Video(local_path))``:
    when enabled, a URL failure must be visible rather than silently starting
    the old multi-part upload path the user asked to avoid.
    """
    if not event_enabled(bridge.config, event):
        return
    value = str(url or '').strip()
    if not value.startswith('https://'):
        raise ValueError('官方视频 URL 发送已启用，但媒体地址不是公网 HTTPS URL')
    # Do not make QQ's /files endpoint wait for a slow provider download. The
    # internal HEAD blocks until Node has a verified complete local file.
    size = await _wait_for_official_media_ready(bridge, value)
    file_type = 4 if size and size > 30_000_000 else 2
    api = getattr(getattr(event, 'bot', None), 'api', None)
    if api is None:
        raise RuntimeError('官方 QQ API 不可用')
    target_group = '' if event.is_private_chat() else str(event.get_group_id() or '')
    target_user = str(event.get_sender_id() or '') if event.is_private_chat() else ''
    if event.is_private_chat():
        register_file = lambda: api.post_c2c_file(
            openid=target_user, file_type=file_type, url=value, srv_send_msg=False,
        )
    else:
        register_file = lambda: api.post_group_file(
            group_openid=target_group, file_type=file_type, url=value, srv_send_msg=False,
        )
    result = None
    for attempt in range(3):
        try:
            result = await asyncio.wait_for(register_file(), 60)
            break
        except asyncio.CancelledError:
            raise
        except Exception:
            if attempt == 2:
                raise
            # Registration is retried before any message is sent, so a
            # transient /files failure cannot create duplicate chat messages.
            await asyncio.sleep(1.5 * (attempt + 1))
    file_uuid = str(_result_value(result, 'file_uuid', '') or '')
    file_info = _result_value(result, 'file_info', '')
    if not file_info:
        raise RuntimeError('官方 URL 转存未返回 file_info')
    media = {
        'file_uuid': file_uuid,
        'file_info': file_info,
        'ttl': _result_value(result, 'ttl', 0) or 0,
    }
    payload = {'msg_type': 7, 'media': media, 'msg_seq': 1}
    if reply_id:
        payload['msg_id'] = str(reply_id)
    if not event_enabled(bridge.config, event):
        return
    if event.is_private_chat():
        payload['openid'] = target_user
        sent = await asyncio.wait_for(api.post_c2c_message(**payload), 60)
    else:
        payload['group_openid'] = target_group
        sent = await asyncio.wait_for(api.post_group_message(**payload), 60)
    receipt = str(_result_value(sent, 'id', '') or '')
    if not receipt:
        raise RuntimeError('官方视频 URL 消息未返回消息 ID；不自动重试')
    logger.info(f'官方 QQ 视频 URL 发送完成：bytes-transfer=server-side receipt={receipt}')
    return receipt


async def send_chain(bridge, event, chain):
    """Send official media, using complete-file URL transfer when enabled."""
    import aiohttp
    if not event_enabled(bridge.config, event):
        return
    video = next((c for c in chain.chain if isinstance(c, Comp.Video)), None)
    if video is None:
        await event.send(chain)
        logger.info('官方 QQ 发送完成：kind=' + ('image' if any(isinstance(c, Comp.Image) for c in chain.chain) else 'text'))
        return
    if bridge.config.get('official_video_url_upload_enabled') is True:
        await send_official_video_url(bridge, event, video.file,
                                      reply_id=str(getattr(event.message_obj, 'message_id', '') or ''))
        return
    if bridge.config.get('official_video_compress_oversize_enabled') is True:
        cache = getattr(bridge, '_official_video_cache', None)
        if cache is None:
            bridge._official_video_cache = cache = OfficialVideoCache()
        timeout = max(60, min(1800, int(bridge.config.get('official_video_compress_timeout_seconds', 900))))
        async with cache.prepare(str(video.file),
                                 ffmpeg=os.environ.get('QQ_MEDIA_FFMPEG_COMMAND') or 'ffmpeg',
                                 timeout=timeout) as prepared:
            if not event_enabled(bridge.config, event):
                return
            # A large MP4 is sent as one downloadable file; its duration is
            # unchanged. This does not change AstrBot's upload transport.
            component = (Comp.File(name='video.mp4', file=str(prepared.path))
                         if prepared.size > 30_000_000 or prepared.original_size > MAX_OFFICIAL_MEDIA_BYTES
                         else Comp.Video(file=str(prepared.path)))
            prepared_chain = MessageChain([component if item is video else item for item in chain.chain])
            prepared_chain.use_markdown_ = False
            await event.send(prepared_chain)
            logger.info(f'官方 QQ 完整视频发送完成：bytes={prepared.size} original_bytes={prepared.original_size} '
                        f'compressed={prepared.original_size > MAX_OFFICIAL_MEDIA_BYTES}')
        return
    maximum = MAX_OFFICIAL_MEDIA_BYTES
    with tempfile.TemporaryDirectory(prefix='longtu-official-video-') as directory:
        path = Path(directory) / 'video.mp4'
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=480)) as session:
            async with session.get(str(video.file)) as response:
                response.raise_for_status()
                expected_size = int(response.headers.get('Content-Length') or 0)
                if expected_size > maximum:
                    raise OfficialMediaTooLarge(expected_size)
                total = 0
                with path.open('wb') as output:
                    async for chunk in response.content.iter_chunked(1024 * 1024):
                        total += len(chunk)
                        if total > maximum:
                            raise OfficialMediaTooLarge(total)
                        output.write(chunk)
        video.file = str(path)
        if not event_enabled(bridge.config, event):
            return
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
    if group and not group_enabled(bridge.config):
        return False
    platform = next((p for p in bridge.context.platform_manager.platform_insts
                     if p.meta().name == 'qq_official' and str(getattr(p, 'appid', ''))
                     == str(bridge.config.get('official_trial_appid'))), None)
    if not platform or not enabled(bridge.config):
        return False
    platform.remember_session_scene(target, 'group' if group else 'friend')
    for chain in chains:
        if group and not group_enabled(bridge.config):
            return False
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
    if not group_enabled(bridge.config):
        logger.info(f'官方疯狂星期四跳过：date={target_date} reason=group-disabled')
        return 0
    if not enabled(bridge.config) or not bridge.config.get('official_trial_push_enabled', False):
        logger.info(f'官方疯狂星期四跳过：date={target_date} reason=disabled')
        return 0
    groups = list(dict.fromkeys(x.strip() for x in str(bridge.config.get('official_trial_push_groups') or '').split(',') if x.strip()))
    if not groups:
        logger.warning(f'官方疯狂星期四跳过：date={target_date} reason=no-target-groups')
        return 0
    text = await bridge._generate_crazy_thursday_text(target_date, scheduled=True)
    sent = 0
    for group in groups:
        try:
            ok = await proactive(bridge, group, [MessageChain([Comp.Plain(text)])], group=True)
            if ok:
                sent += 1
            else:
                logger.warning(f'官方疯狂星期四未确认：date={target_date} group={group}')
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.warning(f'官方疯狂星期四失败：date={target_date} group={group} error={type(error).__name__}')
    logger.info(f'官方疯狂星期四投递：date={target_date} groups={sent}/{len(groups)}')
    return sent


async def _learning_proactive_once(bridge, target, chains, *, group, delivery_id):
    """Retain each official part's receipt across OneBot retries and restarts."""
    if not delivery_id:
        return await proactive(bridge, target, chains, group=group)
    from .learning_report_receipt import connect
    lock = getattr(bridge, '_official_learning_lock', None)
    if lock is None:
        bridge._official_learning_lock = lock = asyncio.Lock()
    async with lock:
        for index, chain in enumerate(chains):
            token = json.dumps([str(bridge.config.get('official_trial_appid')), delivery_id,
                                group, target, index], ensure_ascii=False)
            with connect(bridge) as db:
                db.execute('CREATE TABLE IF NOT EXISTS official_learning_sent (token TEXT PRIMARY KEY)')
                if db.execute('SELECT 1 FROM official_learning_sent WHERE token=?', (token,)).fetchone():
                    continue
            if not await proactive(bridge, target, [chain], group=group):
                return False
            with connect(bridge) as db:
                db.execute('INSERT OR IGNORE INTO official_learning_sent VALUES (?)', (token,))
    return True


async def mirror_learning(bridge, payload, *, delivery_id=""):
    """Deliver official-targeted jobs, or mirror configured administrator reports."""
    if not enabled(bridge.config):
        return None
    appid = str(bridge.config.get('official_trial_appid'))
    prefix = f'qqofficial:{appid}:'
    group = payload.get('chatType') == 'group'
    target = str(payload.get('groupId') if group else payload.get('userId') or '')
    own = target.startswith(prefix)
    if group and not group_enabled(bridge.config):
        return False if own else None
    targets = [target.split(':', 3)[-1]] if own else []
    if not own and not group and bridge.config.get('official_trial_push_enabled', False):
        targets = [key for key, qq in user_bindings(bridge.config).items() if str(qq) == target]
    if not targets:
        return None
    parts = []
    requester = str(payload.get('deliveryUserId') or '')
    if group and payload.get('mentionRequester') and requester.startswith(prefix + 'user:'):
        parts.append(Comp.At(qq=requester.split(':', 3)[-1]))
    parts.append(Comp.Plain(str(payload.get('text') or '')))
    chains = [MessageChain(parts)]
    if payload.get('reportImage') and str(payload.get('imageFile') or '').startswith('base64://'):
        chains.append(MessageChain([Comp.Image(file=payload['imageFile'])]))
    ok = True
    for target in targets:
        try:
            ok = await _learning_proactive_once(
                bridge, target, chains, group=group,
                delivery_id=delivery_id or str(payload.get('waiterKey') or ''),
            ) and ok
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
        if not event_enabled(bridge.config, event):
            event.call_llm = False
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
        raw_text = re.sub(r'^(?:<@!?[A-Za-z0-9_-]+>\s*)+', '', raw_text).strip()
        if raw_text.startswith('/'):
            text = raw_text
        quote = quote_context(components, raw)
        from .official_forward import has_record_header, parse_record, read_record
        current_record_present = has_record_header(text) or has_record_header(raw_text)
        quoted_record = has_record_header(quote['text'])
        # Record attachments/links must never wake the bot or reach the passive
        # backend gate. In groups, require BOTH an explicit quote and @this bot.
        record_authorized = bool(quote['present'] and quoted_record and (private or mentioned))
        if (current_record_present or quoted_record) and not record_authorized:
            event.call_llm = False
            logger.info('官方合并记录已忽略：需要明确引用并 @机器人')
            return
        current_record = parse_record(text) if current_record_present else None
        quote_record = parse_record(quote['text']) if record_authorized else None
        if record_authorized and quote_record is None:
            await event.send(MessageChain([Comp.Plain('这条引用没有附带可读取的聊天记录正文。')]))
            return
        if current_record_present:
            # A separate current record is never part of the quoted evidence.
            text = current_record['text'] if current_record else ''
        bound_user = str(user_bindings(bridge.config).get(str(event.get_sender_id())) or '')
        from .main import ALLOWED_BRIDGE_SLASH_COMMANDS, REPORT_TIMEZONE, nearby_holiday_context, MEDIA_ACK_PATTERN
        from .official_media import extract_official_media
        from .official_gateway import gateway_event
        packet = gateway_event(appid, raw)
        share = extract_official_media(raw, gateway_packet=packet)
        if packet:
            same_body = packet.get('d') == getattr(raw, 'raw_data', None)
            logger.info(f'官方卡片使用网关原始消息：same_body={same_body}')
        rich = share['segments']
        if current_record or quote_record:
            # Attachment URLs belong to supplied chat evidence, not web queries
            # or requests to download a platform video from inside a record.
            rich = []
        # Full group messages feed the existing backend's passive decision gate.
        # A shared URL is a direct share; other chatter is observation only.
        # Never feed this bot's own output or another bot back into the loop.
        if not private and (getattr(getattr(raw, 'author', None), 'bot', False)
                            or str(event.get_sender_id()) == str(event.get_self_id())):
            return
        from .merchant_command import handle_merchant_command
        if await handle_merchant_command(bridge, event, text, official=True):
            return
        has_link = bool(re.search(r'https?://', text, re.IGNORECASE)
                        or MEDIA_ACK_PATTERN.search(str(rich)) or share['search_card'])
        if share['card_present']:
            logger.info('官方分享卡片诊断：' + json.dumps(share['diagnostic'], ensure_ascii=False))
        if share['bilibili_card'] and not share['video_urls'] and not share['search_card'] and not quote['present']:
            notice = MessageChain([Comp.Plain(
                '这张 B 站小程序卡片没能提取到视频地址。请在 B 站选择“复制链接”，把链接发到这里，我再解析。')])
            notice.use_markdown_ = False
            await event.send(notice)
            return
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
        forwarded_text, forward_images = '', []
        quoted_forwarded_text, quoted_forward_images = '', []
        if record_authorized:
            quoted_forwarded_text, quoted_forward_images = await read_record(
                quote_record, getattr(bridge, 'session', None))
        if current_record or quote_record:
            logger.info(f'官方合并记录读图：current={len(forward_images)} quoted={len(quoted_forward_images)} '
                        f'attachments={len((current_record or {}).get("attachments", [])) + len((quote_record or {}).get("attachments", []))}')
        pure_mention = bool(mentioned and not text and not images and not quote['present'] and not current_record)
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
            'learning_delivery_user_id': identity(appid, 'user', event.get_sender_id()),
            'sender_name': event.get_sender_name(),
            'bot_user_id': identity(appid, 'user', event.get_self_id()),
            'text': current_text,
            'pure_bot_mention': pure_mention,
            'mentions': [{'user_id': identity(appid, 'user', c.qq), 'name': getattr(c, 'name', '')}
                         for c in components if isinstance(c, Comp.At)],
            'has_image': bool(images or quote_images or forward_images or quoted_forward_images), 'image_base64s': images,
            'quoted_image_base64s': quote_images,
            'forwarded_text': forwarded_text,
            'forward_image_base64s': forward_images,
            'quoted_forward_image_base64s': quoted_forward_images,
            'quoted_text': '' if quoted_record else quote['text'],
            'quoted_forwarded_text': quoted_forwarded_text,
            'quoted_message_id': identity(appid, 'message', quote['id']),
            'quoted_user_id': (str(user_bindings(bridge.config).get(quote['author_id']) or '')
                               or identity(appid, 'user', quote['author_id'])),
            'quoted_sender_name': quote['author_name'],
            'rich_segments': rich,
            'bilibili_card': share['search_card'] if not share['video_urls'] and not quote['present'] else None,
            'media_share': not (current_record or quote_record) and (not quote['present'] or has_link),
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
                    f'images={len(images)} forward_images={len(forward_images) + len(quoted_forward_images)} observe={observe_only} link={has_link} '
                    f'quote={quote["present"]} quote_chars={len(quote["text"])}')
        media_receipt = bool(not text.startswith('/') and (payload.get('bilibili_card') or MEDIA_ACK_PATTERN.search(text + ' ' + str(rich))))
        from .web_learning_progress import request_learning_backend
        response = await request_learning_backend(bridge, event, payload)
        update = getattr(bridge, '_update_relation_import', None)
        if callable(update):
            update(event, response)
        logger.info(f'官方后端结果：mode={response.get("mode")} types={[row.get("type") for row in response.get("messages", [])]}')
        if response.get('mode') == 'merchant-current':
            # The Node planner only labels an explicit current-store question;
            # reuse the same live snapshot/image path as /远行商人 so natural
            # language and the command cannot drift into different data.
            await handle_merchant_command(bridge, event, '/远行商人', official=True)
            return
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
        if await deliver_learning_report(event, response, bridge):
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
        chains = output_chains(
            response,
            max_messages=budget,
            truncation_notice=not media_receipt,
            official_video_url=bridge.config.get('official_video_url_upload_enabled') is True,
        )
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
        logger.warning('官方 QQ 试用失败：' + json.dumps({
            'stage': media_stage, 'errors': error_diagnostics(error),
        }, ensure_ascii=False))
        if observe_only:
            return
        if media_receipt:
            if isinstance(error, OfficialVideoPreparationError):
                status = str(error)
            elif media_stage == 'send':
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
