"""One short receipt for explicit learning; progress remains user-requested."""
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
    chain = MessageChain([Comp.Plain('收到学习请求，接下来检索网页并审核。可 @我发 /learn-status 查进度，/learn-report 补取报告。')])
    chain.use_markdown_ = False
    try:
        await event.send(chain)
    except Exception as error:
        # An unconfirmed receipt must not cancel learning or be blindly retried.
        logger.warning(f'学习接收提示未确认发送：{type(error).__name__}')
