"""Private merchant subscriptions; never route failed DMs back into the group."""
import asyncio
import base64
import time

from .merchant_alert import round_window, fetch_icons, scheduled_delivery_key, scheduled_notification_text, delivery_plan
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
    config = getattr(monitor.bridge, 'config', {})
    recipients = config.get('merchant_private_recipients')
    if recipients is None and config.get('merchant_alert_delivery') != 'group_private':
        recipients = monitor.mentions  # Preserve existing private-only installations.
    else:
        recipients = [x.strip() for x in str(recipients or '').split(',') if x.strip()]
    if not recipients or not all(x.isdigit() for x in recipients):
        raise ValueError('Private merchant delivery requires explicit QQ recipients')
    pending, statuses = [], []
    for user in dict.fromkeys(recipients):
        key = scheduled_delivery_key(monitor.state, f'private:{user}:{int(window[1])}', now, window[2],
            config.get('merchant_expiry_reminder_enabled') is True)
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
    planned = []
    for user, _ in pending:
        key, chosen, daily_keys = delivery_plan(monitor.state, f'private:{user}', snapshot, selected, now,
            config.get('merchant_expiry_reminder_enabled') is True)
        row = monitor.state.get(key)
        if row and row[0] != 'rejected':
            statuses.append(f'{user}=' + ('already-sent' if row[0] == 'sent' else 'uncertain-held'))
        elif chosen:
            planned.append((user, key, chosen, daily_keys))
        else:
            statuses.append(f'{user}=no-subscribed-goods')
    if not planned:
        return 'private: ' + ' '.join(statuses)
    icons = await fetch_icons(monitor.bridge.session, snapshot['items'])
    created = time.time()
    if created >= snapshot['end']:
        return 'private=expired-before-render'
    images = {}
    for _, _, chosen, _ in planned:
        if tuple(chosen) not in images:
            png = await asyncio.to_thread(render_merchant_card, snapshot, chosen, icons, created)
            images[tuple(chosen)] = {'type': 'image', 'data': {'file': 'base64://' + base64.b64encode(png).decode()}}
    errors = []
    for user, key, chosen, daily_keys in planned:
        if time.time() >= snapshot['end']:
            statuses.append(f'{user}=expired-before-send')
            continue
        text = scheduled_notification_text(snapshot, chosen, created, key)
        message = [{'type': 'text', 'data': {'text': text}}, images[tuple(chosen)]]
        monitor.state.retry_rejected(key)
        if not monitor.state.claim(key, text, time.time(), daily_keys):
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
