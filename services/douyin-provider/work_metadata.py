"""Decode ID-bound Douyin work data; never infer a work's type from DOM timing."""
import json
import re
from urllib.parse import unquote, urlsplit, parse_qs


PAGE_DATA_SCRIPT = r'''() => ({
    render: window.SSR_RENDER_DATA || null,
    scripts: [...document.scripts].filter(s => s.id === 'RENDER_DATA' ||
        s.textContent.trim().startsWith('self.__pace_f.push('))
        .map(s => ({id: s.id, text: s.textContent}))
})'''


def work_id(url):
    parsed = urlsplit(str(url or ''))
    match = re.search(r'/(?:video|note)/(\d+)(?:/|$)', parsed.path)
    if match:
        return match.group(1)
    value = parse_qs(parsed.query).get('modal_id', [''])[0]
    return value if value.isdigit() else ''


def page_payloads(snapshot):
    if isinstance(snapshot.get('render'), dict):
        yield snapshot['render']
    for script in snapshot.get('scripts') or []:
        text = script.get('text', '').strip()
        try:
            if script.get('id') == 'RENDER_DATA':
                yield json.loads(unquote(text))
            elif text.startswith('self.__pace_f.push('):
                frame = json.loads(text[len('self.__pace_f.push('):].removesuffix(';').removesuffix(')'))
                if len(frame) > 1 and isinstance(frame[1], str):
                    for row in frame[1].splitlines():
                        try:
                            yield json.loads(row.split(':', 1)[1])
                        except (ValueError, IndexError):
                            pass  # RSC references/non-JSON rows do not describe a work.
        except (ValueError, TypeError):
            continue


def find_work(payload, target_id):
    if not target_id:
        return None
    if isinstance(payload, dict):
        identity = str(payload.get('aweme_id', payload.get('awemeId', '')))
        # Identity is established by aweme_id, while the presence of media
        # fields prevents an untyped wrapper object from shadowing its detail.
        # aweme_type is intentionally not required here.
        if identity == target_id and any(key in payload for key in (
            'images', 'image_list', 'video', 'video_url', 'videoUrl',
        )):
            return payload
        for value in payload.values():
            result = find_work(value, target_id)
            if result:
                return result
    elif isinstance(payload, list):
        for value in payload:
            result = find_work(value, target_id)
            if result:
                return result
    return None


def first_url(value):
    if isinstance(value, str):
        return value if value.startswith(('https://', 'http://')) else ''
    if isinstance(value, dict):
        value = value.get('url_list') or value.get('urlList') or value.get('src') or ''
        return first_url(value)
    if isinstance(value, list):
        return next((url for item in value if (url := first_url(item))), '')
    return ''


def is_real_video_url(url):
    """Reject audio/thumbnail URLs while accepting signed Douyin video URLs."""
    low = str(url or '').lower()
    return low.startswith(('https://', 'http://')) and 'uuu_265.mp4' not in low and any(
        token in low for token in (
            '.mp4', '.m3u8', 'playwm', 'play/',
            'douyinvod.com/', '/video/', 'mime_type=video_',
        )
    )


def number(value):
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def video_asset(video):
    if not isinstance(video, dict):
        return {}
    addr = video.get('play_addr_h264') or video.get('play_addr') or video.get('playAddr')
    video_url = first_url(addr)
    if not is_real_video_url(video_url):
        return {}
    return {
        'video_url': video_url,
        'size': number(addr.get('data_size')) if isinstance(addr, dict)
            else number(video.get('playAddrSize') or video.get('dataSize')),
        'cover': first_url(video.get('cover')),
        'duration': number(video.get('duration')) / 1000,
    }


def normalize_work(detail, target_id):
    if str(detail.get('aweme_id', detail.get('awemeId', ''))) != target_id:
        return None
    images = detail.get('images')
    author = detail.get('author') or detail.get('authorInfo') or {}
    common = {
        'source_id': target_id, 'type_verified': True,
        'title': detail.get('desc') or detail.get('itemTitle') or '',
        'description': detail.get('desc') or '',
        'author': author.get('nickname') or '',
        'avatar_url': first_url(author.get('avatar_thumb') or author.get('avatarThumb') or author.get('avatarUrl')),
        'tags': [x.get('hashtag_name') or x.get('hashtagName') for x in
                 (detail.get('text_extra') or detail.get('textExtra') or [])
                 if isinstance(x, dict) and (x.get('hashtag_name') or x.get('hashtagName'))],
    }
    main_asset = video_asset(detail.get('video'))
    if isinstance(images, list) and images:
        # Per-image motion assets are allowed, but an independent top-level
        # play address makes the payload ambiguous and must not be guessed.
        if main_asset.get('video_url'):
            return None
        urls, animations = [], []
        for item in images[:18]:
            url = first_url(item)
            if not url:
                return None  # Do not cache an incomplete gallery as a successful result.
            urls.append(url)
            asset = video_asset(item.get('video'))
            if asset.get('video_url'):
                animations.append({**asset, 'cover': url, 'image_index': len(urls) - 1})
        return {**common, 'media_type': 'images', 'video_url': '', 'images': urls,
                'animated_videos': animations, 'cover': urls[0]}
    # The work shape, rather than aweme_type, identifies a normal video. An
    # unknown enum with a real play address is still safe; a missing address is
    # never guessed as a video.
    if main_asset.get('video_url'):
        return {**common, **main_asset, 'media_type': 'video', 'images': []}
    return None
