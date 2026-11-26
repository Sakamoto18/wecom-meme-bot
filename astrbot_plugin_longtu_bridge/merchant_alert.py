"""Current-round merchant monitoring; durable initial and expiry reminders per destination and round."""
import asyncio
import base64
import hashlib
from html.parser import HTMLParser
import json
import logging
from pathlib import Path
import re
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlparse

LOG = logging.getLogger(__name__)
BJ = timezone(timedelta(hours=8))
SOURCE = 'https://www.onebiji.com/hykb_tools/comm/lkwgmerchant/preview.php?id=1&immgj=0'
PROXY = 'https://lk.y1g.cc/proxy.php'


def round_window(now):
    current = datetime.fromtimestamp(now, BJ)
    if current.hour < 8:
        return None
    number = (current.hour - 8) // 4 + 1
    start = current.replace(hour=8 + (number - 1) * 4, minute=0, second=0, microsecond=0)
    return number, start.timestamp(), (start + timedelta(hours=4)).timestamp()


def poll_delay(now):
    window = round_window(now)
    if not window:
        return max(1, datetime.fromtimestamp(now, BJ).replace(hour=8, minute=0, second=0, microsecond=0).timestamp() - now)
    elapsed = now - window[1]
    interval = 15 if elapsed < 300 else 60 if elapsed < 900 else 300
    reminder_at = window[2] - 1800
    boundary = reminder_at if now < reminder_at else window[2]
    return max(1, min(interval, boundary - now))


def retry_delay(now, failures):
    window = round_window(now)
    return max(1, min(poll_delay(now), 15 * 2 ** (min(5, failures) - 1))) if window and failures else poll_delay(now)


class Node:
    def __init__(self, tag='', attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def text(self):
        return ''.join(c if isinstance(c, str) else c.text() for c in self.children).strip()

    def find(self, cls):
        found = [self] if cls in self.attrs.get('class', '').split() else []
        for c in self.children:
            if isinstance(c, Node):
                found.extend(c.find(cls))
        return found

    def tags(self, tag):
        found = [self] if self.tag == tag else []
        for c in self.children:
            if isinstance(c, Node):
                found.extend(c.tags(tag))
        return found


class Tree(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs)
        self.stack[-1].children.append(n)
        if tag not in ('img', 'br', 'meta', 'link', 'input', 'hr', 'source', 'area', 'wbr', 'embed', 'param', 'base'):
            self.stack.append(n)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def parse_source(html, now):
    window = round_window(now)
    if not window:
        raise ValueError('Merchant closed')
    number, start, end = window
    clock = re.search(r'\bvar\s+serverNow\s*=\s*(\d+)\s*;', html)
    if not clock or not start <= int(clock[1]) <= now + 30 or now - int(clock[1]) > 120:
        raise ValueError('Merchant HTML clock is stale')
    day_end = datetime.fromtimestamp(start, BJ).replace(hour=0).timestamp() + 86400
    lists = Tree(html).root.find('shop-list')
    if len(lists) != 1:
        raise ValueError('Merchant page structure changed')
    items = []
    for card in lists[0].tags('li'):
        names = card.find('shop_name')
        if not names:
            continue
        # Source HTML encodes absolute expiry in data-time and explicit round
        # membership in show_N. Yesterday's HTML must never become today's data.
        expiry = int(card.attrs.get('data-time', '0'))
        classes = card.attrs.get('class', '').split()
        if f'show_{number}' not in classes or expiry <= now or expiry > day_end + 1:
            continue
        rounds = [n for n in range(1, 5) if f'show_{n}' in classes]
        if rounds == [1, 2, 3, 4] and abs(expiry - day_end) > 1:
            raise ValueError('All-day merchant expiry conflicts with round membership')
        prices, icons = card.find('shop_price'), card.find('gitem')
        if not prices or not icons:
            raise ValueError('Missing merchant price/icon')
        price = prices[0].text().removeprefix('价格：').strip()
        limit = icons[0].tags('em')
        image = icons[0].tags('img')
        args = re.findall(r"'((?:\\.|[^'\\])*)'", card.attrs.get('onclick', ''))
        if not price or not limit or not image or len(args) != 4:
            raise ValueError('Incomplete merchant item')
        name = names[0].text()
        if args[1] != name:
            raise ValueError('Merchant name mismatch')
        items.append(dict(name=name, price=price, limit=limit[0].text().removeprefix('限购'),
                          currency=card.attrs.get('data-currency') or '洛克贝',
                          image=urljoin(SOURCE, image[0].attrs.get('src', '')),
                          category=args[2], description=args[3], expiresAt=expiry,
                          rounds=rounds))
    if not 1 <= len(items) <= 24:
        raise ValueError('Current merchant round is not published yet')
    if not any(abs(item['expiresAt'] - end) <= 1 for item in items):
        raise ValueError('Only all-day goods available; waiting for current round')
    return dict(items=items, round=number, start=start, end=end, fetchedAt=int(clock[1]), source=SOURCE)


def parse_proxy(data, now):
    window = round_window(now)
    if not window or not isinstance(data, dict):
        raise ValueError('Merchant unavailable')
    number, start, end = window
    def stamp(value):
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    if (data.get('live') is not True or data.get('stale') is not False or data.get('status') != 'open'
            or data.get('round') != number or data.get('expectedRound') != number
            or stamp(str(data.get('startedAtBeijing')) + '+08:00') != start
            or stamp(str(data.get('nextRefreshBeijing')) + '+08:00') != end):
        raise ValueError('Stale or wrong merchant round')
    fetched = stamp(data.get('fetchedAt'))
    if fetched < start or not -30 <= now - fetched <= 600:
        raise ValueError('Merchant cache too old')
    rows = data.get('items')
    if not isinstance(rows, list) or not 1 <= len(rows) <= 24:
        raise ValueError('Missing merchant goods')
    items = []
    for row in rows:
        if not all(row.get(k) for k in ('name', 'image', 'price', 'limit')):
            raise ValueError('Incomplete merchant goods')
        rounds = row.get('rounds', [number])
        if (not isinstance(rounds, list) or not rounds or number not in rounds
                or any(type(n) is not int or not 1 <= n <= 4 for n in rounds)):
            raise ValueError('Invalid merchant item round membership')
        rounds = sorted(set(rounds))
        day_start = datetime.fromtimestamp(start, BJ).replace(hour=8).timestamp()
        expected_end = day_start + max(rounds) * 14400
        expiry = row.get('expiresAt', expected_end)
        if type(expiry) not in (int, float) or abs(expiry - expected_end) > 1 or expiry <= now:
            raise ValueError('Invalid merchant item expiry')
        items.append(dict(row, currency=row.get('currency') or '洛克贝', expiresAt=expiry, rounds=rounds))
    return dict(items=items, round=number, start=start, end=end, fetchedAt=fetched, source=PROXY)


def fingerprint(snapshot):
    # Images and prices are included so delayed upstream corrections are seen.
    return hashlib.sha256(json.dumps(snapshot['items'], ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def delivery_key(group, snapshot):
    return f"{group}:{int(snapshot['start'])}"


def scheduled_delivery_key(state, base, now, end, enabled=False, daily_earlier=False):
    """Late first alerts already serve the last-half-hour purpose; never double-send."""
    if enabled and end - 1800 <= now < end:
        initial = state.get(base)
        if initial and initial[0] == 'sent' and initial[3] < end - 1800:
            return base + ':expiry30'
        if daily_earlier and (not initial or initial[0] == 'rejected'):
            return base + ':expiry30'
    return base


def scheduled_notification_text(snapshot, selected, now, key):
    text = notification_text(snapshot, selected, now)
    return ('【到期提醒 · 已进入最后30分钟】\n' + text.replace('稀有道具上架：', '即将结束售卖：', 1)) if key.endswith(':expiry30') else text


def daily_item(item):
    """Sale duration comes from structured source membership, never an LLM guess."""
    return item.get('rounds') == [1, 2, 3, 4]


def daily_stock_note(snapshot):
    names = '、'.join(item['name'] for item in snapshot['items'] if daily_item(item))
    return f'{names}为当天售卖，至当日24:00结束，不随中间轮次刷新。' if names else ''


def delivery_plan(state, destination, snapshot, selected, now, enabled):
    """Keep round receipts; daily goods get one introduction and the actual expiry."""
    start = datetime.fromtimestamp(snapshot['start'], BJ).replace(hour=8).timestamp()
    legacy_bases = [f'{destination}:{int(start + n * 14400)}' for n in range(4)]
    daily = {}
    for i in selected:
        item = snapshot['items'][i]
        if daily_item(item):
            identity = hashlib.sha256(item['name'].strip().encode()).hexdigest()
            key = f'{destination}:day:{int(start)}:{identity}'
            daily[i] = (key, state.daily_record(key, legacy_bases, item['name']))
    due = enabled and snapshot['end'] - 1800 <= now < snapshot['end']
    def ending(i):
        expiry = snapshot['items'][i].get('expiresAt', snapshot['end'])
        return now < expiry <= min(now + 1800, snapshot['end'])
    earlier = due and any(ending(i) and row and row[0] == 'sent' and row[3] < snapshot['end'] - 1800
                          for i, (_, row) in daily.items())
    key = scheduled_delivery_key(state, delivery_key(destination, snapshot), now, snapshot['end'], enabled, earlier)
    chosen, daily_keys = [], []
    for i in selected:
        daily_key, row = daily.get(i, ('', None))
        known_daily = row and row[0] != 'rejected'
        if key.endswith(':expiry30'):
            if not ending(i) or (known_daily and row[0] != 'sent'):
                continue
        elif known_daily and not (due and ending(i) and row[0] == 'sent'):
            continue
        chosen.append(i)
        if daily_key and not known_daily:
            daily_keys.append(daily_key)
    return key, chosen, daily_keys


class State:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute('CREATE TABLE IF NOT EXISTS selection (key TEXT PRIMARY KEY, selected TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS delivery (key TEXT PRIMARY KEY, state TEXT NOT NULL, text TEXT NOT NULL, receipt TEXT, updated REAL NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS daily_delivery (key TEXT PRIMARY KEY, delivery_key TEXT NOT NULL)')

    def cached(self, key):
        row = self.db.execute('SELECT selected FROM selection WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def cache(self, key, selected):
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO selection VALUES (?,?)', (key, json.dumps(selected)))

    def get(self, key):
        return self.db.execute('SELECT state,text,receipt,updated FROM delivery WHERE key=?', (key,)).fetchone()

    def daily_record(self, key, legacy_bases=(), name=''):
        row = self.db.execute('SELECT delivery_key FROM daily_delivery WHERE key=?', (key,)).fetchone()
        if row and self.get(row[0]):
            return self.get(row[0])
        # Import only our own fixed notification format, not arbitrary chat text.
        # This preserves today's receipts when upgrading an existing deployment.
        for base in legacy_bases:
            for candidate in (base, base + ':expiry30'):
                old = self.get(candidate)
                if not old or old[0] == 'rejected':
                    continue
                for line in old[1].splitlines():
                    prefix = '远行商人稀有道具上架：'
                    if line.startswith(prefix) and name in line[len(prefix):].split('、'):
                        with self.db:
                            self.db.execute('INSERT OR IGNORE INTO daily_delivery VALUES (?,?)', (key, candidate))
                        return old
        return None

    def claim(self, key, text, now, daily_keys=()):
        with self.db:
            # Lock before checking both receipt namespaces, including other workers.
            self.db.execute('BEGIN IMMEDIATE')
            if any((row := self.daily_record(daily_key)) and row[0] != 'rejected' for daily_key in daily_keys):
                return False
            if not self.db.execute("INSERT OR IGNORE INTO delivery VALUES (?,'sending',?,'',?)", (key, text, now)).rowcount:
                return False
            for daily_key in daily_keys:
                self.db.execute('INSERT OR REPLACE INTO daily_delivery VALUES (?,?)', (daily_key, key))
            return True

    def mark(self, key, state, receipt='', now=None):
        with self.db:
            self.db.execute('UPDATE delivery SET state=?,receipt=?,updated=? WHERE key=?', (state, receipt, now or time.time(), key))

    def retry_rejected(self, key):
        with self.db:
            self.db.execute("DELETE FROM delivery WHERE key=? AND state='rejected'", (key,))

    def close(self):
        self.db.close()


async def read_response(response, limit):
    if response.status != 200:
        raise RuntimeError(f'Merchant source HTTP {response.status}')
    data = bytearray()
    async for chunk in response.content.iter_chunked(65536):
        data.extend(chunk)
        if len(data) > limit:
            raise ValueError('Merchant response too large')
    return bytes(data)


async def fetch_snapshot(session, now):
    try:
        async def primary():
            async with session.get(SOURCE, allow_redirects=False) as response:
                return parse_source((await read_response(response, 2_000_000)).decode('utf8'), now)
        return await asyncio.wait_for(primary(), 15)
    except Exception:
        async def fallback():
            async with session.post(PROXY, json={'type': 'merchant'}, allow_redirects=False) as response:
                return parse_proxy(json.loads(await read_response(response, 200_000)), now)
        return await asyncio.wait_for(fallback(), 15)


async def fetch_icons(session, items):
    allowed = ('patchwiki.biligame.com', 'img.71acg.net', 'res.3839pic.com', 'res.onebiji.com')
    icons = {}
    async def one(item):
        url = item['image']
        if urlparse(url).scheme != 'https' or urlparse(url).hostname not in allowed:
            raise ValueError('Unrecognized merchant image host')
        async with session.get(url, allow_redirects=False) as response:
            icons[url] = await read_response(response, 4_000_000)
    # Small catalogue, bounded parallelism. A failed image prevents publishing
    # a misleading old screenshot; the next scheduled tick retries.
    for start in range(0, len(items), 4):
        await asyncio.wait_for(asyncio.gather(*(one(i) for i in items[start:start + 4])), 15)
    return icons


def notification_text(snapshot, selected, now):
    end = datetime.fromtimestamp(snapshot['end'], BJ)
    mins = max(0, int((snapshot['end'] - now) // 60))
    names = '、'.join(snapshot['items'][i]['name'] for i in selected)
    timing = []
    if any(not daily_item(snapshot['items'][i]) for i in selected):
        timing.append(f"本轮道具距结束约 {mins // 60}小时{mins % 60}分，{end:%H:%M} 轮次结束（北京时间）。")
    daily = [snapshot['items'][i] for i in selected if daily_item(snapshot['items'][i])]
    if daily:
        remaining = max(0, int((min(item['expiresAt'] for item in daily) - now) // 60))
        timing.append(f"{'、'.join(item['name'] for item in daily)}为当天售卖，距当日24:00结束约 {remaining // 60}小时{remaining % 60}分，不随中间轮次刷新。")
    return (f"远行商人稀有道具上架：{names}\n" + '\n'.join(timing) + '\n'
            f"当轮在售详情见图｜{datetime.fromtimestamp(snapshot['start'], BJ):%m-%d} 第{snapshot['round']}轮")


async def reconcile(bot, state, key, group, expected_text):
    """An uncertain send is never blindly retried (OneBot has no idempotency key)."""
    info = await asyncio.wait_for(bot.call_action('get_login_info'), 10)
    info = info.get('data', info)
    own_id = str(info.get('user_id') or '')
    if not own_id:
        return False
    result = await asyncio.wait_for(bot.call_action('get_group_msg_history', group_id=int(group), count=100), 15)
    result = result.get('data', result)
    for message in result.get('messages', []):
        if str(message.get('sender', {}).get('user_id') or message.get('user_id')) != own_id:
            continue
        segments = message.get('message', [])
        if not isinstance(segments, list):
            continue
        text = ''.join(s.get('data', {}).get('text', '') for s in segments if s.get('type') == 'text').strip()
        if text == expected_text.strip() and message.get('message_id'):
            state.mark(key, 'sent', str(message['message_id']))
            return True
    return False


class MerchantMonitor:
    def __init__(self, bridge):
        from astrbot.api import logger
        global LOG
        LOG = logger
        self.bridge = bridge
        self.group = str(bridge.config.get('merchant_alert_group', '')).strip()
        self.mentions = [x.strip() for x in str(bridge.config.get('merchant_alert_mentions', '')).split(',') if x.strip()]
        if not self.group.isdigit() or not self.mentions or not all(x.isdigit() for x in self.mentions):
            raise ValueError('Merchant alert requires explicit group and QQ mentions')
        self.state = State('data/plugin_data/longtu_merchant.sqlite')

    async def select(self, snapshot):
        cache_key = 'ten-categories-v4-exact-leader-potion:' + fingerprint(snapshot)
        selected = self.state.cached(cache_key)
        if selected is not None:
            return selected
        url = self.bridge._api_url().removesuffix('/v1/qq/message') + '/v1/qq/merchant/select'
        async def request():
            async with self.bridge.session.post(url, json={'items': snapshot['items']},
                    headers={'Authorization': 'Bearer ' + self.bridge._api_token()}) as response:
                data = json.loads(await read_response(response, 20_000))
                selected = data.get('selected')
                if data.get('ok') is not True or not isinstance(selected, list) or any(type(i) is not int or not 0 <= i < len(snapshot['items']) for i in selected):
                    raise ValueError('Invalid merchant selection response')
                return selected
        selected = await asyncio.wait_for(request(), 25)
        self.state.cache(cache_key, selected)
        return selected

    async def current_snapshot(self, now):
        if getattr(self, '_tick_snapshot', None) is None:
            self._tick_snapshot = await fetch_snapshot(self.bridge.session, now)
        return self._tick_snapshot

    async def tick(self, now=None):
        self._tick_snapshot = None
        config = getattr(self.bridge, 'config', {})
        delivery = config.get('merchant_alert_delivery', 'group')
        if delivery == 'private':
            from .merchant_private import tick_private
            return await tick_private(self, now)
        if delivery not in ('group', 'group_private'):
            raise ValueError('Invalid merchant delivery mode; no fallback to group')
        if delivery == 'group' and config.get('merchant_official_enabled') is not True:
            return await self._tick_napcat(now)
        operations = [('napcat', self._tick_napcat)]
        if delivery == 'group_private':
            from .merchant_private import tick_private
            async def private_operation(timestamp):
                return await tick_private(self, timestamp)
            operations.append(('private', private_operation))
        if config.get('merchant_official_enabled') is True:
            operations.append(('official', self._tick_official))
        statuses, errors = [], []
        for channel, operation in operations:
            try:
                statuses.append(f'{channel}={await operation(now)}')
            except asyncio.CancelledError:
                raise
            except Exception as error:
                errors.append(f'{channel}:{type(error).__name__}')
        if errors:
            raise RuntimeError('Merchant channel failure: ' + ','.join(errors + statuses))
        return ' '.join(statuses)

    async def _tick_napcat(self, now=None):
        now = now or time.time()
        window = round_window(now)
        if not window:
            return 'closed'
        key = scheduled_delivery_key(self.state, f'{self.group}:{int(window[1])}', now, window[2],
            getattr(self.bridge, 'config', {}).get('merchant_expiry_reminder_enabled') is True)
        platform = self.bridge._qq_platform()
        bot = getattr(platform, 'bot', None)
        if not bot:
            raise RuntimeError('NapCat unavailable')
        status = await self._napcat_receipt(bot, key, now)
        if status:
            return status
        snapshot = await self.current_snapshot(now)
        selected = await self.select(snapshot)
        planned_key, selected, daily_keys = delivery_plan(self.state, self.group, snapshot, selected, now,
            getattr(self.bridge, 'config', {}).get('merchant_expiry_reminder_enabled') is True)
        if planned_key != key:
            status = await self._napcat_receipt(bot, planned_key, now)
            if status:
                return status
        key = planned_key
        if not selected:
            return 'no-subscribed-goods'
        icons = await fetch_icons(self.bridge.session, snapshot['items'])
        from .merchant_card import render_merchant_card
        created = time.time()
        if created >= snapshot['end']:
            return 'expired-before-render'
        png = await asyncio.to_thread(render_merchant_card, snapshot, selected, icons, created)
        if time.time() >= snapshot['end']:
            return 'expired-before-send'
        text = scheduled_notification_text(snapshot, selected, created, key)
        if not self.state.claim(key, text, created, daily_keys):
            return 'claimed-by-another-worker'
        message = [{'type': 'at', 'data': {'qq': user}} for user in self.mentions]
        message += [{'type': 'text', 'data': {'text': '\n' + text}},
                    {'type': 'image', 'data': {'file': 'base64://' + base64.b64encode(png).decode()}}]
        try:
            result = await asyncio.wait_for(bot.call_action('send_group_msg', group_id=int(self.group), message=message), 30)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.state.mark(key, 'uncertain')
            raise
        if isinstance(result, dict) and (result.get('status') == 'failed' or result.get('retcode', 0) not in (0, None)):
            self.state.mark(key, 'rejected')
            raise RuntimeError('Merchant notification rejected by QQ')
        data = result.get('data', result) if isinstance(result, dict) else {}
        receipt = data.get('message_id')
        self.state.mark(key, 'sent' if receipt else 'uncertain', str(receipt or ''))
        LOG.info(f'Merchant alert delivery: key={key} receipt={receipt or "unconfirmed"}')
        return 'sent' if receipt else 'uncertain'

    async def _napcat_receipt(self, bot, key, now):
        row = self.state.get(key)
        if row:
            if row[0] == 'sent':
                return 'already-sent'
            if row[0] in ('sending', 'uncertain'):
                if now - row[3] < 30:
                    return 'pending-receipt'
                if await reconcile(bot, self.state, key, self.group, row[1]):
                    return 'receipt-recovered'
                self.state.mark(key, 'uncertain', now=now)
                LOG.warning(f'Merchant delivery uncertain; held to avoid duplicate @: {key}')
                return 'uncertain'
            self.state.retry_rejected(key)
        return None

    async def _tick_official(self, now=None):
        from .official_policy import group_enabled
        if not group_enabled(self.bridge.config):
            return 'official-group-disabled'
        from .merchant_official import scheduled_target, official_platform, prepare_mention_image, send_image, proactive_allowed
        now = now or time.time()
        window = round_window(now)
        if not window:
            return 'closed'
        target = scheduled_target(self.bridge.config, self.group, self.mentions)
        if target is None:
            return 'waiting-verified-group-and-members'
        group, members = target
        platform = official_platform(self.bridge)
        if not platform:
            raise RuntimeError('Official QQ platform unavailable')
        key = scheduled_delivery_key(self.state, f'official:{platform.appid}:{group}:{int(window[1])}',
            now, window[2], self.bridge.config.get('merchant_expiry_reminder_enabled') is True)
        row = self.state.get(key)
        if row:
            # QQ's official API has no arbitrary history query for reconciling
            # a timeout. Preserve uncertain sends instead of sending again.
            return 'already-sent' if row[0] == 'sent' else 'uncertain-held'
        if not await proactive_allowed(platform.client, group):
            return 'waiting-group-proactive-permission'
        snapshot = await self.current_snapshot(now)
        selected = await self.select(snapshot)
        key, selected, daily_keys = delivery_plan(self.state, f'official:{platform.appid}:{group}', snapshot,
            selected, now, self.bridge.config.get('merchant_expiry_reminder_enabled') is True)
        row = self.state.get(key)
        if row:
            return 'already-sent' if row[0] == 'sent' else 'uncertain-held'
        if not selected:
            return 'no-subscribed-goods'
        icons = await fetch_icons(self.bridge.session, snapshot['items'])
        from .merchant_card import render_merchant_card
        created = time.time()
        png = await asyncio.to_thread(render_merchant_card, snapshot, selected, icons, created)
        # Upload is preparation, not a visible message: failures can safely retry.
        async with prepare_mention_image(platform.client, png) as media:
            if time.time() >= snapshot['end']:
                return 'expired-before-send'
            text = scheduled_notification_text(snapshot, selected, created, key)
            if not self.state.claim(key, text, time.time(), daily_keys):
                return 'claimed-by-another-worker'
            try:
                receipt = await send_image(platform.client, group, media, text, members)
            except asyncio.CancelledError:
                raise
            except Exception:
                self.state.mark(key, 'uncertain')
                raise
            self.state.mark(key, 'sent', receipt)
        LOG.info(f'Official merchant alert delivered: group={group} receipt={receipt}')
        return 'sent'

    async def run(self):
        LOG.info(f'Merchant monitor enabled: group={self.group} hours=08/12/16/20 Asia/Shanghai')
        failures = 0
        try:
            while not self.bridge.report_stop.is_set():
                try:
                    status = await self.tick()
                    LOG.info(f'Merchant check: {status}')
                    failures = 0
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    LOG.warning(f'Merchant check failed: {error}')
                    failures = min(5, failures + 1)
                try:
                    now = time.time()
                    await asyncio.wait_for(self.bridge.report_stop.wait(), retry_delay(now, failures))
                except asyncio.TimeoutError:
                    continue
        finally:
            self.state.close()
