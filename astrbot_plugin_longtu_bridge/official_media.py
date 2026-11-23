"""Bounded protocol parsing for official QQ cards; no title/intent guessing."""
import html
import json
import re
from itertools import islice
from urllib.parse import parse_qs, unquote, urlsplit

_ASSET_KEYS = {'avatar', 'avatar_url', 'source_logo', 'preview', 'cover', 'cover_url',
               'thumbnail', 'icon', 'image', 'image_url'}
_IDENTITY_KEYS = {'author', 'mentions', 'member_openid', 'user_openid', 'openid'}
_SOURCE_KEYS = {'source', 'appname', 'app_name', 'desc'}
_BILI_NAMES = {'哔哩哔哩', 'bilibili', 'com.bilibili.app'}
_URL = re.compile(r'(?=(https?://[^\s<>"\x27`]+))', re.I)
_BVID = re.compile(r'BV[0-9A-Za-z]{10}\Z')


def _host(url):
    try:
        return (urlsplit(url).hostname or '').lower()
    except ValueError:
        return ''


def _bili_host(host):
    return host == 'bilibili.com' or host.endswith('.bilibili.com') or host == 'b23.tv'


def _video_url(value, *, bili_context=False):
    """Normalize explicit video URLs/deep links or a verified miniapp page."""
    try:
        parsed = urlsplit(value)
    except ValueError:
        return ''
    host = _host(value)
    if host == 'live.bilibili.com' or host.endswith('.live.bilibili.com'):
        return ''
    if host == 'b23.tv' and parsed.path.strip('/'):
        return value
    if not (_bili_host(host) or parsed.scheme == 'bilibili'
            or bili_context and not parsed.scheme and not parsed.netloc):
        return ''
    query = parse_qs(parsed.query)
    bvid = (query.get('bvid') or [''])[0]
    aid = (query.get('aid') or [''])[0]
    match = re.search(r'(?:^|/)(BV[0-9A-Za-z]{10}|av[0-9]+)(?:/|$)', parsed.path)
    if match:
        if match[1].startswith('BV'):
            bvid = match[1]
        else:
            aid = match[1][2:]
    # bilibili://video/123456 is the app's numeric video route.
    if parsed.scheme == 'bilibili' and host == 'video' and parsed.path.strip('/').isdigit():
        aid = parsed.path.strip('/')
    video_id = bvid if _BVID.fullmatch(bvid) else f'av{aid}' if re.fullmatch(r'[1-9][0-9]*', aid) else ''
    if not video_id:
        return ''
    part = (query.get('p') or query.get('page') or [''])[0]
    suffix = '?p=' + part if re.fullmatch(r'[1-9][0-9]*', part) else ''
    return 'https://www.bilibili.com/video/' + video_id + suffix


def extract_official_media(raw, gateway_packet=None):
    data = (gateway_packet.get('d') if isinstance(gateway_packet, dict)
            else getattr(raw, 'raw_data', None))
    data = data if isinstance(data, dict) else {}
    content = str(data.get('content') or getattr(raw, 'content', '') or '')
    # This is QQ's observed card envelope, not a natural-language intent rule.
    lines = content.strip().splitlines()
    envelope = bool(lines and lines[0].strip() == '[卡片消息] 小程序')
    envelope_bili = envelope and any(line.strip() == 'source: 哔哩哔哩' for line in lines[1:])
    videos, links, fields, hosts = [], [], [], set()
    bili_card = envelope_bili
    card_present = envelope or any(k in data for k in ('ark', 'ark_data', 'msg_elements'))
    nodes = 0
    truncated = False

    def add_video(value):
        if value and value not in videos and len(videos) < 8:
            videos.append(value)

    def walk(value, path='', depth=0, context=False, key=''):
        nonlocal nodes, truncated, bili_card
        nodes += 1
        if depth > 12 or nodes > 2048:
            truncated = True
            return
        if len(fields) < 80 and path:
            # Only field paths/types; never titles, cookies, identity or raw URLs.
            fields.append(path[:120] + ':' + type(value).__name__)
        if isinstance(value, dict):
            context = context or any(str(value.get(k, '')).lower() in _BILI_NAMES for k in _SOURCE_KEYS)
            bili_card = bili_card or context
            if context:
                bvid, aid = str(value.get('bvid', '')), str(value.get('aid', ''))
                if _BVID.fullmatch(bvid):
                    add_video(_video_url('pages/video?bvid=' + bvid + '&p=' + str(value.get('p') or value.get('page') or ''), bili_context=True))
                elif re.fullmatch(r'[1-9][0-9]*', aid):
                    add_video(_video_url('pages/video?aid=' + aid + '&p=' + str(value.get('p') or value.get('page') or ''), bili_context=True))
            for k, item in list(value.items())[:64]:
                name = str(k).lower()
                if name in _IDENTITY_KEYS or name in _ASSET_KEYS:
                    continue
                # A quote's card is historical, never a new video share.
                if name == 'msg_elements' and str(data.get('message_type', getattr(raw, 'message_type', ''))) == '103':
                    continue
                walk(item, f'{path}.{k}' if path else str(k), depth + 1, context, name)
        elif isinstance(value, list):
            for i, item in enumerate(value[:32]):
                walk(item, f'{path}[{i}]', depth + 1, context, key)
        elif isinstance(value, str):
            if len(value) > 256 * 1024:
                truncated = True
                return
            if value.lstrip().startswith(('{', '[')):
                try:
                    walk(json.loads(value), path, depth + 1, context, key)
                    return
                except ValueError:
                    pass
            # QQ's textual envelope puts asset URLs inside content, not fields.
            if envelope and key == 'content':
                value = '\n'.join(line for line in value.splitlines()
                                  if line.partition(':')[0].strip() not in _ASSET_KEYS)
            decoded = html.unescape(value.replace('\\/', '/'))
            for _ in range(3):
                for match in islice(_URL.finditer(decoded), 64):
                    candidate = match[1].rstrip('),.;!?]}，。！？）')[:4096]
                    host = _host(candidate)
                    if host:
                        hosts.add(host)
                        video = _video_url(candidate)
                        add_video(video)
                        if not video and candidate not in links and len(links) < 24:
                            links.append(candidate)
                for candidate in re.findall(r'bilibili://[^\s<>"\x27]+', decoded):
                    add_video(_video_url(candidate))
                if key in {'path', 'page', 'url', 'qqdocurl', 'jumpurl', 'jump_url'}:
                    add_video(_video_url(decoded.strip(), bili_context=context))
                more = unquote(decoded)
                if more == decoded:
                    break
                decoded = more

    # Preserve structures until URL/ID extraction; raw botpy content can exist
    # even when a transport does not expose raw_data.
    walk({**data, 'content': content}, context=envelope_bili)
    ark = data.get('ark_data') or {}
    card_fields = ark.get('fields', {}) if isinstance(ark, dict) else {}
    search_card = None
    if (bili_card and isinstance(ark, dict) and isinstance(card_fields, dict) and ark.get('ark_type') == 'miniapp'
            and card_fields.get('title') and card_fields.get('preview')):
        search_card = {'title': str(card_fields['title'])[:200], 'preview': str(card_fields['preview'])[:4096]}
    urls = (videos + [u for u in links if u not in videos])[:8]
    return {
        'search_card': search_card,
        'segments': [{'type': 'json', 'data': {'url': url}} for url in urls],
        'card_present': card_present,
        'bilibili_card': bili_card,
        'video_urls': videos,
        'diagnostic': {'message_type': str(data.get('message_type', getattr(raw, 'message_type', '')))[:12],
                       'fields': fields, 'url_hosts': sorted(hosts)[:24],
                       'video_count': len(videos), 'bilibili_card': bili_card,
                       'truncated': truncated},
    }
