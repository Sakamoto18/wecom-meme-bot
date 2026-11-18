"""Private merchant subscriptions; never route failed DMs back into the group."""
import asyncio
import base64
import time

from .merchant_alert import round_window, fetch_icons, notification_text
from .merchant_card import render_merchant_card


def response_data(result):
    if isinstance(result, dict) and (result.get('status') == 'failed'
                                   or result.get('retcode', 0) not in (0, None)):
        raise RuntimeError('Private merchant API rejected request')
    return result.get('data', result) if isinstance(result, dict) else result


async def tick_private(monitor, now=None):
    from .merchant_alert import LOG
    now = now or time.time()
    window = round_window(now)
    if not window:
        return 'private=closed'
    platform = monitor.bridge._qq_platform()
    bot = getattr(platform, 'bot', None)
    if bot is None:
        raise RuntimeError('NapCat unavailable for private merchant alerts')
    # No group_id on send_private_msg: this NapCat build can fall back to a
    # group message if resolving the target UID fails when group_id is supplied.
    friends = response_data(await asyncio.wait_for(bot.call_action('get_friend_list'), 15))
    if not isinstance(friends, list):
        raise ValueError('Cannot verify private merchant recipients')
    friend_ids = {str(row.get('user_id')) for row in friends if isinstance(row, dict)}
    pending, statuses = [], []
    for user in dict.fromkeys(monitor.mentions):
        key = f'private:{user}:{int(window[1])}'
        row = monitor.state.get(key)
        if row and row[0] == 'sent':
            statuses.append(f'{user}=already-sent')
        elif row and row[0] != 'rejected':
            # An uncertain receipt cannot justify duplicate private alerts.
            statuses.append(f'{user}=uncertain-held')
        elif user not in friend_ids:
            statuses.append(f'{user}=waiting-friend')
        else:
            pending.append((user, key))
    if not pending:
        return 'private: ' + ' '.join(statuses)
    snapshot = await monitor.current_snapshot(now)
    selected = await monitor.select(snapshot)
    if not selected:
        return 'private=no-subscribed-goods ' + ' '.join(statuses)
    icons = await fetch_icons(monitor.bridge.session, snapshot['items'])
    created = time.time()
    if created >= snapshot['end']:
        return 'private=expired-before-render'
    png = await asyncio.to_thread(render_merchant_card, snapshot, selected, icons, created)
    text = notification_text(snapshot, selected, created)
    message = [{'type': 'text', 'data': {'text': text}},
               {'type': 'image', 'data': {'file': 'base64://' + base64.b64encode(png).decode()}}]
    errors = []
    for user, key in pending:
        if time.time() >= snapshot['end']:
            statuses.append(f'{user}=expired-before-send')
            continue
        monitor.state.retry_rejected(key)
        if not monitor.state.claim(key, text, time.time()):
            statuses.append(f'{user}=claimed-by-another-worker')
            continue
        try:
            result = await asyncio.wait_for(bot.call_action('send_private_msg', user_id=int(user), message=message), 30)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            monitor.state.mark(key, 'uncertain')
            errors.append(f'{user}:{type(error).__name__}')
            continue
        if isinstance(result, dict) and (result.get('status') == 'failed' or result.get('retcode', 0) not in (0, None)):
            monitor.state.mark(key, 'rejected')
            errors.append(f'{user}:rejected')
            continue
        data = response_data(result)
        receipt = data.get('message_id') if isinstance(data, dict) else None
        monitor.state.mark(key, 'sent' if receipt else 'uncertain', str(receipt or ''))
        statuses.append(f'{user}=' + ('sent' if receipt else 'uncertain-held'))
        LOG.info(f'Merchant private delivery: user={user} receipt={receipt or "unconfirmed"}')
    if errors:
        # One recipient's failure never prevents the others receiving their DM.
        raise RuntimeError('Merchant private failures: ' + ','.join(errors + statuses))
    return 'private: ' + ' '.join(statuses)
