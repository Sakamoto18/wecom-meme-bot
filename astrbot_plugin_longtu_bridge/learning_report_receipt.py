"""Preserve platform report-send receipts; persist failed backend acknowledgements."""
import asyncio
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from astrbot.api import logger


def receipt_id(result):
    if isinstance(result, dict):
        if result.get('status') == 'failed' or result.get('retcode', 0) not in (0, None):
            raise RuntimeError('Report send rejected')
        data = result.get('data') if isinstance(result.get('data'), dict) else result
        value = data.get('message_id') or data.get('id')
    else:
        value = getattr(result, 'id', None)
    return str(value) if isinstance(value, (str, int)) and str(value) else ''


async def send_with_receipt(event, chain):
    platform = getattr(event, 'get_platform_name', lambda: '')()
    if platform == 'qq_official':
        # AstrBot send() discards the response. Use its exact underlying send path.
        event.send_buffer = chain
        result = await event._post_send()
        raw_id = receipt_id(result)
        if raw_id:
            from .official_trial import identity
            # Same namespace as inbound quote_context -> payload.quoted_message_id.
            bot_id = str(event.get_self_id())
            appid = getattr(getattr(event.bot, 'platform', None), 'appid', '') or bot_id
            return identity(str(appid), 'message', raw_id)
        return ''
    if platform == 'aiocqhttp':
        import astrbot.api.message_components as Comp
        segments = []
        for part in chain.chain:
            if isinstance(part, Comp.Plain):
                segments.append({'type': 'text', 'data': {'text': part.text}})
            elif isinstance(part, Comp.At):
                segments.append({'type': 'at', 'data': {'qq': str(part.qq)}})
            elif isinstance(part, Comp.Image):
                segments.append({'type': 'image', 'data': {'file': part.file}})
        destination = {'user_id': int(event.get_sender_id())} if event.is_private_chat() else {'group_id': int(event.get_group_id())}
        result = await event.bot.call_action('send_private_msg' if event.is_private_chat() else 'send_group_msg',
                                             **destination, message=segments)
        return receipt_id(result)
    return receipt_id(await event.send(chain))


def outbox_path(bridge):
    return Path(getattr(bridge, '_learning_receipt_db', '') or 'data/plugin_data/longtu_learning_receipts.sqlite')


@contextmanager
def connect(bridge):
    path = outbox_path(bridge)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute('CREATE TABLE IF NOT EXISTS receipts (token TEXT PRIMARY KEY, body TEXT NOT NULL)')
    try:
        with db:
            yield db
    finally:
        db.close()


async def flush_receipts(bridge):
    if not getattr(bridge, 'session', None):
        return
    lock = getattr(bridge, '_learning_receipt_lock', None)
    if lock is None:
        bridge._learning_receipt_lock = lock = asyncio.Lock()
    async with lock:
        with connect(bridge) as db:
            rows = db.execute('SELECT token,body FROM receipts LIMIT 20').fetchall()
        for token, body in rows:
            try:
                url = bridge._api_url().rsplit('/', 1)[0] + '/learning-report-receipt'
                async with asyncio.timeout(5):
                    async with bridge.session.post(url, json=json.loads(body),
                            headers={'Authorization': 'Bearer ' + bridge._api_token()}) as response:
                        result = await response.json(content_type=None)
                        if response.status != 200 or not result.get('ok'):
                            raise RuntimeError('Report receipt not accepted')
                with connect(bridge) as db:
                    db.execute('DELETE FROM receipts WHERE token = ?', (token,))
            except Exception as error:
                logger.warning(f'学习报告回执待补登：{type(error).__name__}')
                break


async def remember_receipt(bridge, token, message_id):
    if not token or not message_id:
        logger.warning('学习报告没有可登记的发送 ID；保留图片/标题定位，不猜测消息 ID')
        return
    body = {'token': token, 'message_id': message_id}
    with connect(bridge) as db:
        db.execute('INSERT OR REPLACE INTO receipts VALUES (?, ?)', (token, json.dumps(body)))
    await flush_receipts(bridge)
