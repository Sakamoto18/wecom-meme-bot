#!/usr/bin/env python3
"""Import the public rendered NRC wiki (stdlib only). Never execute wiki Lua.

Cached pages allow interrupted imports to resume. Only a complete validated
snapshot replaces the live database; --refresh ignores the previous cache.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import sqlite3
import time
import urllib.parse
import urllib.request
import urllib.error

BASE = 'https://wiki.biligame.com/nrc/'
VOID = {'img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'embed', 'param', 'col'}


class Node:
    def __init__(self, tag='', attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def find(self, tag=None, cls=None):
        return [n for n in self.walk() if (not tag or n.tag == tag)
                and (not cls or cls in n.attrs.get('class', '').split())]

    def walk(self):
        for child in self.children:
            if isinstance(child, Node):
                yield child
                yield from child.walk()

    def text(self):
        return ' '.join(' '.join(c.text() if isinstance(c, Node) else c
                               for c in self.children).split())


class Tree(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def source_link(node):
    for a in node.find('a'):
        href = a.attrs.get('href', '')
        if href.startswith('/nrc/') and 'redlink=1' not in href:
            return a.text(), urllib.parse.urljoin(BASE, href)
    raise ValueError('Missing canonical wiki link: ' + node.text()[:80])


def parse_index(page, kind):
    root = Tree(page['parse']['text']['*']).root
    records = []
    if kind == 'effect':
        for card in root.find(cls='nrc-game-description-card'):
            headings = [n for n in card.walk() if n.attrs.get('data-nrc-tag') == 'h2']
            name, url = source_link(headings[0])
            desc = card.find(cls='nrc-game-description-card-desc')[0].text()
            records.append(dict(id='effect:' + name, kind=kind, name=name, url=url,
                                fields={'分类': card.attrs.get('data-game-description-category'), '效果': desc}))
    else:
        table = root.find('table', 'npc-table' if kind == 'pet' else 'nrc-skill-table')[0]
        headers = [n.attrs.get('data-column', n.text()) for n in table.find('th')]
        for row in table.find('tr'):
            cells = row.find('td')
            if not cells:
                continue
            if len(cells) != len(headers):
                raise ValueError('Wiki table schema changed')
            fields = {key: cell.text() for key, cell in zip(headers, cells)}
            name, url = source_link(cells[2 if kind == 'pet' else 1])
            display_name = name
            name = urllib.parse.unquote(url.split('/nrc/', 1)[1])
            if kind == 'pet':
                # Several forms share a displayed name (鸭吉吉). The canonical
                # page title, not visible link text, identifies a form.
                fields['types'] = cells[3].attrs.get('data-sort-value') or row.attrs.get('data-type')
                fields.pop('avatar', None)
                for key in ('ride', 'doubleRide'):
                    cell = cells[headers.index(key)]
                    fields[key] = '、'.join(n.attrs['aria-label'] for n in cell.walk() if n.attrs.get('aria-label')) or cell.text()
            elif kind == 'trait':
                fields['携带精灵系别'] = cells[2].attrs.get('data-sort-value', '')
                fields['拥有精灵'] = cells[3].attrs.get('title', '')
                if not fields['拥有精灵']:
                    fields['拥有精灵'] = '、'.join(n.attrs['title'] for n in cells[3].walk() if n.attrs.get('title'))
            else:
                fields['技能属性'] = row.attrs.get('data-skill-catalog-type', fields['技能属性'])
                fields['赛季'] = row.attrs.get('data-skill-catalog-season', '')
            records.append(dict(id=kind + ':' + name, kind=kind, name=name,
                                aliases=[display_name] if display_name != name else [], url=url, fields=fields))
            if kind == 'pet':
                records[-1]['wikiPetId'] = row.attrs.get('data-id', '')
    for record in records:
        record['revision'] = page['parse']['revid']
        record['fetchedAt'] = page.get('fetchedAt', '')
    return records


def parse_pet(page, expected_id=''):
    root = Tree(page['parse']['text']['*']).root
    pets = [n for n in root.walk() if n.attrs.get('data-sd-kind') == 'pet']
    if not pets:
        raise ValueError('Missing public pet detail')
    if expected_id and pets[0].attrs.get('data-pet-id') != expected_id:
        raise ValueError('Pet form identity mismatch: ' + expected_id)
    skills = []
    for n in pets[0].find(cls='sd-p-skill-card'):
        a = n.attrs
        desc = n.find(cls='sd-p-skill-description')
        skills.append({'名称': a['data-name'], '习得': {'level': '自学', 'machine': '技能石', 'blood': '血脉'}.get(a['data-source'], a['data-source']),
                       '等级': a.get('data-level', ''), '属性': a.get('data-type', ''),
                       '分类': a.get('data-category', ''), '威力': a.get('data-power', ''),
                       '能耗': a.get('data-energy', ''), '效果': desc[0].text() if desc else ''})
    return skills, pets[0].attrs.get('data-nrc-codex', '')


class Fetcher:
    def __init__(self, cache, refresh=False):
        self.cache, self.refresh = Path(cache), refresh
        self.cache.mkdir(parents=True, exist_ok=True)

    def fetch(self, title):
        target = self.cache / (hashlib.sha256(title.encode()).hexdigest() + '.json')
        if target.exists() and not self.refresh:
            return json.loads(target.read_text(encoding='utf8'))
        url = BASE + 'api.php?' + urllib.parse.urlencode(dict(action='parse', page=title, prop='text|revid', format='json', redirects=1))
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={'User-Agent': 'LongtuGameKnowledge/1.0 (public wiki index; cached; 2 workers)'})
                with urllib.request.urlopen(req, timeout=60) as response:
                    data = json.load(response)
                if 'parse' not in data:
                    raise ValueError(str(data.get('error', 'Missing parse')))
                data['fetchedAt'] = datetime.now(timezone.utc).isoformat()
                target.write_text(json.dumps(data, ensure_ascii=False), encoding='utf8')
                time.sleep(.8)
                return data
            except urllib.error.HTTPError as error:
                if error.code in (403, 412, 429, 567):
                    raise RuntimeError('Wiki visitor check/rate limit; stop automated retries. Use the browser cache transport, then resume with the same --cache directory.') from error
                if attempt == 3:
                    raise
                time.sleep(2 ** (attempt + 1))
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2 ** (attempt + 1))


def save_snapshot(output, records):
    if len({r['id'] for r in records}) != len(records):
        raise ValueError('Duplicate entity IDs')
    counts = {kind: sum(r['kind'] == kind for r in records) for kind in ('pet', 'skill', 'trait', 'effect')}
    if any(counts[k] < n for k, n in {'pet': 100, 'skill': 100, 'trait': 50, 'effect': 10}.items()):
        raise ValueError('Incomplete index: ' + str(counts))
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        with sqlite3.connect(output) as old:
            previous = json.loads(old.execute('SELECT value FROM metadata').fetchone()[0])['counts']
        if any(counts[k] < previous[k] * .9 for k in counts):
            raise ValueError('Unexpected >10% shrink; inspect upstream before replacing database')
    temp = output.with_suffix('.importing.sqlite')
    temp.unlink(missing_ok=True)
    metadata = dict(version=1, game='洛克王国世界', importedAt=datetime.now(timezone.utc).isoformat(),
                    source=BASE, attribution='Bilibili 洛克王国世界 WIKI 编辑者', license='CC BY-SA 4.0', counts=counts)
    with sqlite3.connect(temp) as db:
        db.execute('CREATE TABLE metadata(value TEXT NOT NULL)')
        db.execute('INSERT INTO metadata VALUES (?)', (json.dumps(metadata, ensure_ascii=False),))
        db.execute('CREATE TABLE entries(id TEXT PRIMARY KEY, kind TEXT, name TEXT, payload TEXT NOT NULL)')
        db.executemany('INSERT INTO entries VALUES (?, ?, ?, ?)', [(r['id'], r['kind'], r['name'], json.dumps(r, ensure_ascii=False)) for r in records])
    os.replace(temp, output)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='data/roco-world.sqlite')
    parser.add_argument('--cache', default='data/roco-wiki-cache')
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()
    fetcher = Fetcher(args.cache, args.refresh)
    records = []
    for title, kind in [('精灵列表', 'pet'), ('技能列表', 'skill'), ('特性列表', 'trait'), ('游戏描述图鉴', 'effect')]:
        entries = parse_index(fetcher.fetch(title), kind)
        records.extend(entries)
        print(title, len(entries), flush=True)
    pets = [r for r in records if r['kind'] == 'pet']

    def detail(pet):
        title = urllib.parse.unquote(pet['url'].split('/nrc/', 1)[1])
        page = fetcher.fetch(title)
        pet['skills'], pet['version'] = parse_pet(page, pet.get('wikiPetId', ''))
        pet['detailRevision'] = page['parse']['revid']
        pet['detailFetchedAt'] = page.get('fetchedAt', '')
        return pet

    with ThreadPoolExecutor(max_workers=2) as pool:
        for i, pet in enumerate(pool.map(detail, pets), 1):
            if i % 25 == 0 or i == len(pets):
                print('精灵技能关联', i, '/', len(pets), pet['name'], flush=True)
    print(json.dumps(save_snapshot(args.output, records), ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
