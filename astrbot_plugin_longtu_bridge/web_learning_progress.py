"""Learning receipts, bounded progress, and automatic report delivery."""
import re
from astrbot.api import logger
from astrbot.api.event import MessageChain
import astrbot.api.message_components as Comp


def is_learning_request(text):
    text = str(text or '').strip()
    if re.match(r'^/learn-meme\s+\S', text, re.I):
        return True
    if re.search(r'https?://|这个视频|视频里的', text, re.I):
        return False
    return bool(re.match(r'^(?:请|帮我|麻烦)?\s*(?:去网上|上网|联网)\s*(?:重新)?(?:学(?:习)?(?:一下)?|了解一下)\s*\S', text)
                or re.match(r'^(?:你)?(?:去|帮我|请)?\s*(?:重新)?学(?:习)?(?:一下)?\s*.+?(?:相关梗|这个梗|这个网络梗)', text))


async def learning_receipt(event, payload):
    if payload.get('observe_only') or not is_learning_request(payload.get('text')):
        return
    if not event.is_private_chat():
        bot = str(payload.get('bot_user_id') or '')
        mentioned = any(str(item.get('user_id')) == bot for item in payload.get('mentions', []))
        if not bot or not (mentioned or str(payload.get('quoted_user_id') or '') == bot):
            return
    chain = MessageChain([Comp.Plain('行，我去翻翻资料，核清楚再把报告拿回来。久了会告诉你进度。')])
    chain.use_markdown_ = False
    try:
        await event.send(chain)
    except Exception as error:
        # An unconfirmed receipt must not cancel learning or be blindly retried.
        logger.warning(f'学习接收提示未确认发送：{type(error).__name__}')


def learning_targeted(event, payload):
    if payload.get('observe_only') or not is_learning_request(payload.get('text')):
        return False
    if event.is_private_chat():
        return True
    bot = str(payload.get('bot_user_id') or '')
    return bool(bot and (any(str(item.get('user_id')) == bot for item in payload.get('mentions', []))
                         or str(payload.get('quoted_user_id') or '') == bot))


def progress_line(text):
    # Fixed role-voice lines describe actual stages; no fabricated percentage or LLM call.
    for marker, line in (
        ('正在检索网页', '还在翻资料，等我找点靠谱的说法。'),
        ('正在提取网页结论', '资料翻到了，正在捋这梗到底怎么用。'),
        ('正在审核置信度', '还在核出处，不能看见个说法就当真。'),
        ('正在写入梗库', '审核过了，正在把能记的内容存下来。'),
        ('已完成，已入库', '学完了，报告还在出图，马上拿来。'),
        ('审核完成，未入库', '资料看完了，有些地方还没核实，正在整理报告。'),
        ('失败，未入库', '这次没学成，正在整理哪里出了问题。'),
    ):
        if marker in text:
            return line
    return '还在等这次学习结果，没溜。'


async def request_learning_backend(bridge, event, payload, *, intervals=(35, 45)):
    """One receipt + at most two progress notices, leaving a final-report slot in QQ."""
    import asyncio
    import contextlib
    if getattr(bridge, 'session', None):
        try:
            from .learning_report_receipt import flush_receipts
            await flush_receipts(bridge)
        except Exception as error:
            logger.warning(f'学习回执补登暂不可用：{type(error).__name__}')
    if not learning_targeted(event, payload):
        return await bridge._request_backend(payload)
    await learning_receipt(event, payload)
    request = asyncio.create_task(bridge._request_backend(payload))
    async def progress():
        for delay in intervals:
            await asyncio.sleep(delay)
            if request.done():
                return
            query = {k: payload[k] for k in ('message_type', 'group_id', 'user_id', 'bot_user_id', 'mentions', 'quoted_user_id') if k in payload}
            query['text'] = '/learn-status'
            try:
                status = await asyncio.wait_for(bridge._request_backend(query), timeout=5)
                if request.done():
                    return
                body = '\n'.join(str(row.get('text') or '') for row in status.get('messages', []))
                same_task = payload.get('message_id') and str(status.get('learning_request_id') or '') == str(payload['message_id'])
                line = progress_line(body) if same_task else '这次学习还在等处理，没忘，结果出来就拿给你。'
                chain = MessageChain([Comp.Plain(line)])
                chain.use_markdown_ = False
                await asyncio.wait_for(event.send(chain), timeout=12)
            except Exception as error:
                logger.warning(f'学习进度提示未确认发送：{type(error).__name__}')
    ticker = asyncio.create_task(progress())
    try:
        return await request
    finally:
        ticker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await ticker
        if not request.done():
            request.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await request


async def deliver_learning_report(event, response, bridge=None):
    """Deliver the finished request in its original event, @ raw sender (QQ/OpenID)."""
    if not response.get('learning_completed') and not response.get('learning_report_term'):
        return False
    parts = []
    if not event.is_private_chat() and response.get('learning_completed'):
        parts.extend([Comp.At(qq=str(event.get_sender_id())), Comp.Plain(' ')])
    term = str(response.get('learning_report_term') or '')
    if term:
        parts.append(Comp.Plain(f'《{term}》学习报告\n管理员回复“入库”即可保存梗义和用法。\n'))
    for row in response.get('messages', []):
        if row.get('type') == 'image' and row.get('base64'):
            parts.append(Comp.Image(file='base64://' + row['base64']))
        elif row.get('type') == 'text' and row.get('text'):
            parts.append(Comp.Plain(row['text']))
    chain = MessageChain(parts)
    chain.use_markdown_ = False
    try:
        if bridge is not None and response.get('learning_delivery_token'):
            from .learning_report_receipt import send_with_receipt
            message_id = await send_with_receipt(event, chain)
        else:
            message_id = ''
            await event.send(chain)
        logger.info('联网学习报告已发送：群内提醒发起人' if not event.is_private_chat() else '联网学习报告已发送：私聊')
    except Exception as error:
        logger.warning(f'联网学习报告未确认送达：{type(error).__name__}')
        # Never blindly resend a possibly delivered report. A short recovery notice is distinct.
        notice = MessageChain([*([Comp.At(qq=str(event.get_sender_id())), Comp.Plain(' ')] if not event.is_private_chat() else []),
                               Comp.Plain('报告发出去时出了点问题，先别重学；发 /learn-report 就能补取。')])
        notice.use_markdown_ = False
        try:
            await event.send(notice)
        except Exception as notice_error:
            logger.warning(f'学习报告补取提示未确认发送：{type(notice_error).__name__}')
    else:
        if bridge is not None and response.get('learning_delivery_token'):
            try:
                from .learning_report_receipt import remember_receipt
                await remember_receipt(bridge, response['learning_delivery_token'], message_id)
            except Exception as error:
                logger.warning(f'学习报告已发出但回执存档失败：{type(error).__name__}')
    return True
