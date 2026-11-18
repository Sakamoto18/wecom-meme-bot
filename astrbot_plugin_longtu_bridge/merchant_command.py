"""Explicit /远行商人 command, independent of the rare-item scheduler."""
import asyncio
import base64
import time
from datetime import datetime

from .merchant_alert import BJ, State, fetch_snapshot, fetch_icons, round_window
from .merchant_card import render_merchant_card


async def handle_merchant_command(bridge, event, text, *, official=False):
    if text.strip() != '/远行商人':
        return False
    import astrbot.api.message_components as Comp
    from astrbot.api.event import MessageChain
    from astrbot.api import logger
    async def notice(value):
        chain = MessageChain([Comp.Plain(value)])
        chain.use_markdown_ = False
        await event.send(chain)

    if event.is_private_chat():
        await notice('请在群里发送 /远行商人，查看当前商店。')
        return True
    if not official and not bridge._group_is_allowed(event):
        return True
    # Explicitly address one bot when both official and NapCat are in the group.
    mentions = [str(c.qq) for c in event.get_messages() if isinstance(c, Comp.At)]
    if mentions and str(event.get_self_id()) not in mentions:
        return True
    locks = getattr(bridge, '_merchant_command_locks', None)
    if locks is None:
        bridge._merchant_command_locks = locks = {}
    group = str(event.get_group_id())
    key = ('official' if official else 'napcat', group)
    # Repeated clicks while the first image is preparing must not queue spam.
    lock = locks.setdefault(key, asyncio.Lock())
    if lock.locked():
        return True
    async with lock:
        state = State('data/plugin_data/longtu_merchant.sqlite')
        event_id = str(event.message_obj.message_id or '')
        delivery_key = f'command:{key[0]}:{group}:{event_id}'
        try:
            if event_id and state.get(delivery_key):
                return True
            now = time.time()
            if not round_window(now):
                await notice('远行商人现在休息中，北京时间 08:00 开门；营业时间为 08:00—24:00。')
                return True
            try:
                snapshot = await fetch_snapshot(bridge.session, now)
                icons = await fetch_icons(bridge.session, snapshot['items'])
                created = time.time()
                png = await asyncio.to_thread(render_merchant_card, snapshot, [], icons, created)
                end = datetime.fromtimestamp(snapshot['end'], BJ)
                minutes = max(0, int((snapshot['end'] - created) // 60))
                text = f'远行商人当前第{snapshot["round"]}轮｜距刷新约{minutes // 60}小时{minutes % 60}分，{end:%H:%M}刷新（北京时间）。\n本轮商品、价格与限购见图。'
                media = None
                if official:
                    from .merchant_official import prepare_image
                    media = await prepare_image(event.bot, group, png)
                if time.time() >= snapshot['end']:
                    raise ValueError('Round changed while preparing merchant image')
            except Exception as error:
                logger.warning(f'Merchant command preparation failed: {type(error).__name__}')
                await notice('本轮商店数据或图片暂未更新完成，稍后再试 /远行商人；不会用上一轮库存代替。')
                return True
            if not event_id:
                await notice('这条命令缺少消息标识，请重新发送 /远行商人。')
                return True
            if not state.claim(delivery_key, text, time.time()):
                return True
            try:
                if official:
                    from .merchant_official import send_image
                    receipt = await send_image(event.bot, group, media, text, reply_id=event_id)
                else:
                    result = await asyncio.wait_for(event.bot.call_action('send_group_msg', group_id=int(group), message=[
                        {'type': 'text', 'data': {'text': text}},
                        {'type': 'image', 'data': {'file': 'base64://' + base64.b64encode(png).decode()}},
                    ]), 30)
                    if isinstance(result, dict) and (result.get('status') == 'failed' or result.get('retcode', 0) not in (0, None)):
                        raise RuntimeError('Merchant command delivery rejected')
                    receipt = (result.get('data', result) if isinstance(result, dict) else {}).get('message_id')
                state.mark(delivery_key, 'sent' if receipt else 'uncertain', str(receipt or ''))
                logger.info(f'Merchant command delivered: platform={key[0]} group={group} receipt={receipt or "unconfirmed"}')
            except Exception as error:
                state.mark(delivery_key, 'uncertain')
                logger.warning(f'Merchant command send unconfirmed; no resend: {type(error).__name__}')
            return True
        finally:
            state.close()
            if len(locks) > 200:
                for old in list(locks):
                    if old != key and not locks[old].locked():
                        del locks[old]
