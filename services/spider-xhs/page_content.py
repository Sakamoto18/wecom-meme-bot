"""Extract content already present in a public share page. No script execution."""
import json
import re
from urllib.parse import urlsplit


def is_note_url(url):
    parsed = urlsplit(url)
    return (parsed.scheme in ('http', 'https')
            and parsed.hostname in ('www.xiaohongshu.com', 'xiaohongshu.com')
            and re.fullmatch(r'/(?:explore|discovery/item|item)/[a-zA-Z0-9]+/?', parsed.path) is not None)


def note_url_from_response(response):
    # A public note may redirect again to an error page. That page's final
    # path must never become source_note_id='error'. Keep the original query.
    for hop in [*response.history, response]:
        if is_note_url(hop.url):
            return hop.url
    raise ValueError('短链未返回有效笔记地址')


def normalize_note(note):
    kind = note.get('type')
    images = []
    for item in note.get('imageList', note.get('image_list', [])) or []:
        infos = item.get('infoList', item.get('info_list', [])) or []
        preferred = next((info for info in infos if info.get('imageScene', info.get('image_scene')) == 'WB_DFT'), {})
        url = preferred.get('url') or item.get('urlDefault') or item.get('url_default') or item.get('url')
        url = url or next((info.get('url') for info in infos if info.get('url')), None)
        if isinstance(url, str) and url.startswith(('https://', 'http://')) and url not in images:
            images.append(url)
    content = {
        'title': str(note.get('title') or ''),
        'description': str(note.get('desc') or '').replace('[话题]', '').strip(),
        'cover': images[0] if images else '',
    }
    if kind == 'normal':
        if not images:
            raise ValueError('图文笔记缺少图片数据')
        return {**content, 'media_type': 'gallery', 'images': images[:18], 'video_url': ''}
    if kind == 'video':
        streams = (note.get('video') or {}).get('media', {}).get('stream', {}).get('h264', [])
        streams = [s for s in streams if isinstance(s, dict)
                   and (s.get('masterUrl') or s.get('master_url') or s.get('url') or '').startswith(('https://', 'http://'))]
        streams.sort(key=lambda s: int(s.get('height') or 0))
        selected = next((s for s in streams if int(s.get('height') or 0) >= 720), streams[-1] if streams else None)
        if not selected:
            raise ValueError('视频笔记缺少可用视频流，不发送封面图集')
        return {**content, 'media_type': 'video', 'images': [],
                'video_url': selected.get('masterUrl') or selected.get('master_url') or selected.get('url')}
    raise ValueError('笔记类型无法识别')


def parse_public_note(html, canonical_url):
    parsed = urlsplit(canonical_url)
    if parsed.hostname not in ('www.xiaohongshu.com', 'xiaohongshu.com'):
        return None
    path = re.fullmatch(r'/(?:explore|discovery/item|item)/([a-zA-Z0-9]+)/?', parsed.path)
    match = re.search(r'window\.__INITIAL_STATE__\s*=\s*(.*?)</script>', html, re.S)
    if not path or not match:
        return None
    raw = match.group(1).strip().rstrip(';')
    raw = re.sub(r'"(?:\\.|[^"\\])*"|\bundefined\b', lambda m: 'null' if m[0] == 'undefined' else m[0], raw)
    try:
        state = json.loads(raw)
    except (ValueError, TypeError):
        return None
    note = ((state.get('note') or {}).get('noteDetailMap') or {}).get(path[1], {}).get('note')
    if not note or (note.get('noteId') and note['noteId'] != path[1]):
        return None
    return normalize_note(note)
