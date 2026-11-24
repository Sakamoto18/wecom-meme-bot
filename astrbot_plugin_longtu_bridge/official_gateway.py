"""Keep card events before botpy/AstrBot conversion; bounded, optional raw capture."""
from collections import OrderedDict
from hashlib import sha256
import json
import os
from pathlib import Path
import time

_EVENT_NAMES = {'GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE'}
_MAX_BYTES = 1024 * 1024


class GatewayCards:
    def __init__(self, directory, logger=None):
        self.directory = Path(directory)
        self.logger = logger
        self.events = OrderedDict()
        self.bytes = 0

    def record(self, message, now=None):
        now = time.time() if now is None else now
        encoded = message.encode('utf8') if isinstance(message, str) else message
        if not isinstance(encoded, bytes) or len(encoded) > _MAX_BYTES:
            return
        try:
            packet = json.loads(encoded)
        except (ValueError, UnicodeError):
            return
        if not isinstance(packet, dict) or packet.get('op') != 0 or packet.get('t') not in _EVENT_NAMES:
            return
        data = packet.get('d')
        if not isinstance(data, dict) or not data.get('id'):
            return
        if not (data.get('ark_data') or data.get('ark') or data.get('msg_elements')
                or str(data.get('message_type')) == '3'):
            return
        key = (str(data.get('group_openid') or ''), str(data['id']))
        self._prune(now)
        old = self.events.pop(key, None)
        if old:
            self.bytes -= len(old[1])
        self.events[key] = (now, encoded)
        self.bytes += len(encoded)
        while len(self.events) > 64 or self.bytes > 8 * _MAX_BYTES:
            _, (_, removed) = self.events.popitem(last=False)
            self.bytes -= len(removed)
        self._capture(packet, encoded, now)

    def _prune(self, now):
        while self.events and next(iter(self.events.values()))[0] < now - 600:
            _, (_, removed) = self.events.popitem(last=False)
            self.bytes -= len(removed)

    def lookup(self, group_id, message_id, now=None):
        self._prune(time.time() if now is None else now)
        item = self.events.get((str(group_id or ''), str(message_id)))
        return json.loads(item[1]) if item else None

    def _capture(self, packet, encoded, now):
        """An operator arms only a specific group for a short capture window."""
        arm_path = self.directory / 'arm.json'
        if not arm_path.exists():
            return
        try:
            arm = json.loads(arm_path.read_text(encoding='utf8'))
            if not now < float(arm.get('expires_at', 0)) <= now + 3600:
                return
            data = packet['d']
            if not arm.get('group_openid') or str(data.get('group_openid')) != str(arm['group_openid']):
                return
            limit = max(1, min(int(arm.get('max_events', 3)), 10))
            prefix = sha256(str(arm.get('capture_id', '')).encode()).hexdigest()[:12]
            if len(list(self.directory.glob(prefix + '-*.json'))) >= limit:
                return
            target = self.directory / (prefix + '-' + sha256(encoded).hexdigest()[:20] + '.json')
            if target.exists():
                return
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as output:
                output.write(encoded)  # exact received JSON, including envelope and opaque fields
            if self.logger:
                self.logger.info(f'官方网关原始卡片已保存：file={target.name} bytes={len(encoded)}')
        except Exception as error:
            if self.logger:
                self.logger.warning(f'官方原始卡片保存失败：{type(error).__name__}')


def install_gateway_capture(appid, directory, logger=None, websocket_class=None):
    if websocket_class is None:
        from botpy.gateway import BotWebSocket
        websocket_class = BotWebSocket
    stores = getattr(websocket_class.on_message, '_longtu_card_stores', None)
    if stores is None:
        stores = {}
        original = websocket_class.on_message

        async def on_message(socket, ws, message):
            platform = getattr(getattr(socket, '_client', None), 'platform', None)
            store = stores.get(str(getattr(platform, 'appid', '') or ''))
            if store:
                try:
                    store.record(message)
                except Exception as error:
                    if store.logger:
                        store.logger.warning(f'官方网关卡片保留失败：{type(error).__name__}')
            return await original(socket, ws, message)

        on_message._longtu_card_stores = stores
        websocket_class.on_message = on_message
    store = GatewayCards(directory, logger)
    stores[str(appid)] = store
    return store


def gateway_event(appid, raw):
    from botpy.gateway import BotWebSocket
    stores = getattr(BotWebSocket.on_message, '_longtu_card_stores', {})
    store = stores.get(str(appid))
    if not store:
        return None
    return store.lookup(getattr(raw, 'group_openid', ''), getattr(raw, 'id', ''))
