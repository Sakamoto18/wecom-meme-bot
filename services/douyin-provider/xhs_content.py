"""Extract content already present in a public share page. No script execution."""
from html.parser import HTMLParser
import json
import re
from urllib.parse import urlsplit


# These are navigation/account labels rendered by the logged-in XHS page, not
# the author of the note being resolved.  Keep this filter centralized because
# the same bad value can arrive through the initial state, captured API JSON,
# or the DOM fallback.
XHS_NON_AUTHOR_LABELS = {
    '我', '首页', '发现', '通知', '消息', '登录', '注册', '搜索', '推荐', '热门',
    '我的', '账号', '用户', '个人中心',
}


def clean_author_name(value):
    """Return a note author name, never a logged-in-account navigation label."""
    if not isinstance(value, str):
        return ''
    name = value.strip()
    if not name or name in XHS_NON_AUTHOR_LABELS:
        return ''
    if any(token in name for token in ('登录后', '登录/注册', '个人中心')):
        return ''
    return name[:120]


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
    kind = str(note.get('type') or note.get('noteType') or note.get('note_type') or '').lower()
    images = []
    raw_images = note.get('imageList', note.get('image_list', note.get('images', []))) or []
    if isinstance(raw_images, dict):
        raw_images = list(raw_images.values())
    for item in raw_images:
        if isinstance(item, str):
            if item.startswith(('https://', 'http://')) and item not in images:
                images.append(item)
            continue
        if not isinstance(item, dict):
            continue
        infos = item.get('infoList', item.get('info_list', [])) or []
        if isinstance(infos, dict):
            infos = list(infos.values())
        preferred = next((info for info in infos if info.get('imageScene', info.get('image_scene')) == 'WB_DFT'), {})
        url = (preferred.get('url') or preferred.get('urlDefault') or preferred.get('url_default')
               or item.get('urlDefault') or item.get('url_default') or item.get('urlPre')
               or item.get('url_pre') or item.get('url'))
        url = url or next((info.get('url') or info.get('urlDefault') or info.get('url_default')
                           for info in infos if isinstance(info, dict)
                           and (info.get('url') or info.get('urlDefault') or info.get('url_default'))), None)
        if isinstance(url, str) and url.startswith(('https://', 'http://')) and url not in images:
            images.append(url)
    raw_users = [note.get(key) for key in
                 ('user', 'user_info', 'userInfo', 'author', 'authorInfo')]
    user_objects = []
    author_texts = []
    for raw_user in raw_users:
        if isinstance(raw_user, list):
            raw_user = next((item for item in raw_user if isinstance(item, dict)), None)
        if isinstance(raw_user, dict):
            user_objects.append(raw_user)
        else:
            author_text = clean_author_name(raw_user)
            if author_text:
                author_texts.append(author_text)
    user = next((candidate for candidate in user_objects
                 if any(clean_author_name(candidate.get(key)) for key in
                        ('nickname', 'nickName', 'nick_name', 'userName', 'username', 'name'))), {})
    user_author = next((clean_author_name(user.get(key)) for key in
                        ('nickname', 'nickName', 'nick_name', 'userName', 'username', 'name')
                        if clean_author_name(user.get(key))), '')
    raw_avatar = (user.get('avatar') or user.get('avatarUrl') or user.get('avatar_url')
                  or user.get('image') or user.get('imageb') or user.get('images') or '') if user_author else ''
    if isinstance(raw_avatar, list):
        raw_avatar = next((item for item in raw_avatar if isinstance(item, str)), '')
    tags = []
    for tag in note.get('tagList', note.get('tag_list', [])) or []:
        name = tag.get('name') if isinstance(tag, dict) else tag
        if isinstance(name, str) and name.strip() and name.strip() not in tags:
            tags.append(name.strip())
    author_candidates = (
        user.get('nickname'), user.get('nickName'), user.get('nick_name'),
        user.get('userName'), user.get('username'), user.get('name'),
        note.get('nickname'), note.get('nickName'), note.get('authorName'),
        note.get('author_name'), *author_texts,
    )
    author = next((clean_author_name(item) for item in author_candidates
                   if clean_author_name(item)), '')
    content = {
        'title': str(note.get('title') or note.get('display_title') or note.get('displayTitle') or ''),
        'description': str(note.get('desc') or note.get('description') or note.get('content') or '')
        .replace('[话题]', '').strip(),
        'cover': images[0] if images else '',
        'author': author,
        # Never pair the logged-in user's avatar with an empty/filtered author.
        'avatarUrl': str(raw_avatar) if author and user_author else '',
        'tags': tags,
    }
    if kind == 'normal':
        if not images:
            raise ValueError('图文笔记缺少图片数据')
        return {**content, 'media_type': 'gallery', 'images': images[:18], 'video_url': ''}
    if kind == 'video':
        video = note.get('video') or note.get('video_info') or note.get('videoInfo') or {}
        media = video.get('media') if isinstance(video, dict) else {}
        stream = media.get('stream') if isinstance(media, dict) else {}
        streams = stream.get('h264', []) if isinstance(stream, dict) else []
        if isinstance(streams, dict):
            streams = list(streams.values())
        streams = [s for s in streams if isinstance(s, dict)
                   and (s.get('masterUrl') or s.get('master_url') or s.get('url')
                        or s.get('master_url_hd') or '').startswith(('https://', 'http://'))]
        streams.sort(key=lambda s: int(s.get('height') or 0))
        selected = next((s for s in streams if int(s.get('height') or 0) >= 720), streams[-1] if streams else None)
        if not selected:
            raise ValueError('视频笔记缺少可用视频流，不发送封面图集')
        return {**content, 'media_type': 'video', 'images': [],
                'video_url': selected.get('masterUrl') or selected.get('master_url')
                or selected.get('master_url_hd') or selected.get('url')}
    raise ValueError('笔记类型无法识别')


class _PageMetadataParser(HTMLParser):
    """Read public OG/JSON-LD metadata without executing page scripts."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta = {}
        self.json_ld = []
        self._json_ld_depth = 0
        self._json_ld_chunks = []

    def handle_starttag(self, tag, attrs):
        attributes = {str(key).lower(): str(value or '') for key, value in attrs}
        if tag.lower() == 'meta':
            key = (attributes.get('property') or attributes.get('name')
                   or attributes.get('itemprop') or '').strip().lower()
            value = attributes.get('content', '').strip()
            if key and value:
                self.meta.setdefault(key, []).append(value)
        elif tag.lower() == 'script' and attributes.get('type', '').lower() == 'application/ld+json':
            self._json_ld_depth = 1
            self._json_ld_chunks = []

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag.lower() == 'script':
            self.handle_endtag(tag)

    def handle_data(self, data):
        if self._json_ld_depth:
            self._json_ld_chunks.append(data)

    def handle_endtag(self, tag):
        if tag.lower() == 'script' and self._json_ld_depth:
            self.json_ld.append(''.join(self._json_ld_chunks).strip())
            self._json_ld_depth = 0
            self._json_ld_chunks = []


def _metadata_values(parser, *keys):
    values = []
    for key in keys:
        values.extend(parser.meta.get(key.lower(), []))
    return values


def _http_urls(values):
    result = []
    for value in values:
        if isinstance(value, str) and value.startswith(('https://', 'http://')) and value not in result:
            result.append(value)
    return result


def _json_ld_fields(doc):
    """Extract standard VideoObject/Article fields from JSON-LD."""
    fields = {'types': [], 'images': [], 'videos': [], 'title': '', 'description': '', 'author': ''}

    def visit(value, depth=0):
        if depth > 8 or value is None:
            return
        if isinstance(value, list):
            for item in value:
                visit(item, depth + 1)
            return
        if not isinstance(value, dict):
            return
        raw_type = value.get('@type') or value.get('type')
        if isinstance(raw_type, list):
            fields['types'].extend(str(item).lower() for item in raw_type)
        elif raw_type:
            fields['types'].append(str(raw_type).lower())
        for key, item in value.items():
            normalized = str(key).replace('_', '').lower()
            if normalized in {'contenturl', 'videourl', 'embedurl', 'streamurl'}:
                fields['videos'].extend(_http_urls([item] if isinstance(item, str) else []))
            elif normalized in {'image', 'images', 'thumbnailurl', 'thumbnail'}:
                if isinstance(item, str):
                    fields['images'].extend(_http_urls([item]))
                elif isinstance(item, dict):
                    fields['images'].extend(_http_urls([item.get('url'), item.get('contentUrl')]))
                elif isinstance(item, list):
                    for entry in item:
                        if isinstance(entry, str):
                            fields['images'].extend(_http_urls([entry]))
                        elif isinstance(entry, dict):
                            fields['images'].extend(_http_urls([entry.get('url'), entry.get('contentUrl')]))
            elif normalized in {'headline', 'title', 'name'} and not fields['title'] and isinstance(item, str):
                fields['title'] = item.strip()
            elif normalized in {'description', 'abstract'} and not fields['description'] and isinstance(item, str):
                fields['description'] = item.strip()
            elif normalized == 'author':
                if isinstance(item, dict) and isinstance(item.get('name'), str):
                    fields['author'] = item['name'].strip()
                elif isinstance(item, str):
                    fields['author'] = item.strip()
            visit(item, depth + 1)

    visit(doc)
    fields['types'] = list(dict.fromkeys(fields['types']))
    fields['images'] = list(dict.fromkeys(fields['images']))
    fields['videos'] = list(dict.fromkeys(fields['videos']))
    return fields


def _parse_public_metadata(html):
    parser = _PageMetadataParser()
    try:
        parser.feed(html)
    except (TypeError, ValueError):
        return parser, []
    fields = []
    for raw in parser.json_ld:
        try:
            fields.append(_json_ld_fields(json.loads(raw)))
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
    return parser, fields


def _metadata_note(html, canonical_url):
    """Build a usable note from server-rendered OG/JSON-LD fallback metadata."""
    parser, json_fields = _parse_public_metadata(html)
    og_images = _http_urls(_metadata_values(parser, 'og:image', 'twitter:image', 'image'))
    ld_images = [url for fields in json_fields for url in fields['images']]
    images = list(dict.fromkeys([*og_images, *ld_images]))[:18]
    title_values = _metadata_values(parser, 'og:title', 'twitter:title', 'title')
    description_values = _metadata_values(parser, 'og:description', 'twitter:description', 'description')
    title = title_values[0] if title_values else ''
    description = description_values[0] if description_values else ''
    author = ''
    types = []
    video_urls = _http_urls(_metadata_values(
        parser, 'og:video', 'og:video:url', 'twitter:player:stream', 'video', 'contenturl',
    ))
    for fields in json_fields:
        types.extend(fields['types'])
        video_urls.extend(fields['videos'])
        title = title or fields['title']
        description = description or fields['description']
        author = author or fields['author']
    types = list(dict.fromkeys(types))
    video_urls = list(dict.fromkeys(video_urls))
    is_video = bool(video_urls) or any('video' in item for item in types)
    if is_video:
        if not video_urls:
            return None
        return {
            'title': title, 'description': description, 'cover': images[0] if images else '',
            'author': author, 'avatarUrl': '', 'tags': [], 'media_type': 'video',
            'images': [], 'video_url': video_urls[0],
        }
    if not images:
        return None
    return {
        'title': title, 'description': description, 'cover': images[0],
        'author': author, 'avatarUrl': '', 'tags': [], 'media_type': 'gallery',
        'images': images, 'video_url': '',
    }


def parse_public_note(html, canonical_url):
    parsed = urlsplit(canonical_url)
    if parsed.hostname not in ('www.xiaohongshu.com', 'xiaohongshu.com'):
        return None
    path = re.fullmatch(r'/(?:explore|discovery/item|item)/([a-zA-Z0-9]+)/?', parsed.path)
    match = re.search(r'window\.__INITIAL_STATE__\s*=\s*(.*?)</script>', html, re.S)
    if path and match:
        raw = match.group(1).strip().rstrip(';')
        raw = re.sub(r'"(?:\\.|[^"\\])*"|\bundefined\b', lambda m: 'null' if m[0] == 'undefined' else m[0], raw)
        try:
            state = json.loads(raw)
            note = ((state.get('note') or {}).get('noteDetailMap') or {}).get(path[1], {}).get('note')
            if note and (not note.get('noteId') or note['noteId'] == path[1]):
                return normalize_note(note)
        except (ValueError, TypeError, KeyError):
            pass
    return _metadata_note(html, canonical_url)
