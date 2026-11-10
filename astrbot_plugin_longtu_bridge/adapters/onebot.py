"""OneBot/NapCat implementation. No protocol calls belong in business handlers."""
import asyncio
import os
from ..video_delivery_cache import VideoForwardRejected
from .types import Capabilities, DeliveryError, Target, delivery_receipt

VIDEO_SEND_TIMEOUT_SECONDS = 480


def select_platform(context):
    manager = getattr(context, 'platform_manager', None)
    for platform in getattr(manager, 'platform_insts', []):
        try:
            if platform.meta().name == 'aiocqhttp':
                return platform
        except Exception:
            continue
    return None


def transport_for(owner=None, *, event=None, bot=None):
    config = getattr(owner, 'config', {}) or {}
    # Freeze selection with the plugin instance, so a live config edit cannot
    # mix two implementations in one event. Reload is the activation boundary.
    mode = getattr(owner, 'transport_mode', None) or os.getenv('LONGTU_QQ_TRANSPORT_MODE') or config.get('transport_mode', 'legacy')
    mode = mode.strip()
    if mode not in ('legacy', 'adapter'):
        raise ValueError('transport_mode must be legacy or adapter')
    client = bot if bot is not None else getattr(event, 'bot', None)
    return (OneBotAdapter if mode == 'adapter' else LegacyOneBotAdapter)(client)


class LegacyOneBotAdapter:
    """Compatibility implementation: existing arguments/results pass unchanged.

    Selection is exclusive, never shadow-send through both implementations.
    """
    name = 'onebot'
    capabilities = Capabilities()

    def __init__(self, bot, *, capabilities=None):
        self.bot = bot
        if capabilities is not None:
            self.capabilities = capabilities

    @property
    def available(self):
        return callable(getattr(self.bot, 'call_action', None))

    @staticmethod
    def destination(target):
        return ('send_private_msg', {'user_id': int(target.id)}) if target.kind == 'private' else (
            'send_group_msg', {'group_id': int(target.id)})

    @staticmethod
    def target(destination):
        return Target('group', destination['group_id']) if 'group_id' in destination else Target('private', destination['user_id'])

    def require(self, capability):
        if not getattr(self.capabilities, capability):
            raise DeliveryError(capability, 'rejected', 'unsupported')

    async def send(self, target, message):
        action, destination = self.destination(target)
        return await self.bot.call_action(action, **destination, message=message)

    async def send_forward(self, target, nodes):
        self.require('send_forwards')
        action, destination = self.destination(target)
        return await self.bot.call_action(action.replace('_msg', '_forward_msg'), **destination, messages=nodes)

    async def react(self, message_id, emoji_id):
        self.require('reactions')
        try:
            message_id = int(message_id)
        except ValueError:
            pass
        return await self.bot.call_action('set_msg_emoji_like', message_id=message_id, emoji_id=emoji_id, set=True)

    async def read_message(self, message_id, **routing):
        self.require('quotes')
        return await self.bot.call_action(action='get_msg', message_id=str(message_id), **routing)

    async def read_forward(self, message_id, **routing):
        self.require('receive_forwards')
        return await self.bot.call_action(action='get_forward_msg', message_id=str(message_id), **routing)

    async def read_image(self, file, **routing):
        return await self.bot.call_action(action='get_image', file=file, **routing)

    async def history(self, group_id, message_id, count):
        self.require('history')
        return await self.bot.call_action('get_group_msg_history', group_id=int(group_id),
                                          message_seq=str(message_id), count=count, reverseOrder=False)

    async def groups(self):
        return await self.bot.get_group_list(no_cache=False)

    async def group(self, group_id):
        return await self.bot.get_group_info(group_id=int(group_id), no_cache=False)

    @staticmethod
    async def send_session(context, session, chain):
        return await context.send_message(session, chain)

    @staticmethod
    async def send_event(event, chain):
        return await event.send(chain)

    @staticmethod
    def reply_result(event, chain):
        return event.chain_result(chain)

    @staticmethod
    def cache_account(event, account):
        platform_id = getattr(event, 'unified_msg_origin', '').split(':', 1)[0]
        return ('onebot', platform_id, str(account))

    async def send_video(self, target: Target, video_url: str):
        """Wait for a real OneBot receipt, with a per-call video timeout."""
        bot = self.bot
        action, destination = self.destination(target)
        call_action = getattr(bot, 'call_action', None)
        if not callable(call_action):
            raise RuntimeError('QQ Bot API 不支持 call_action')
        # aiocqhttp has no public per-call timeout. Copy its lightweight API
        # wrappers while sharing the live connections and ResultStore. Changing
        # bot._api in place would also change concurrent chat/card requests.
        api = getattr(bot, '_api', None)
        if api is not None and hasattr(api, '_wsr_api'):
            def clone_wrapper(wrapper):
                # AsyncApi.__getattr__ treats even __setstate__ as an API
                # action, so copy.copy() invokes the wrong method. These
                # wrappers only hold a small __dict__ of connection references.
                cloned = object.__new__(type(wrapper))
                cloned.__dict__.update(wrapper.__dict__)
                return cloned
            api = clone_wrapper(api)
            for name in ('_wsr_api', '_http_api'):
                transport = getattr(api, name, None)
                if transport is not None:
                    transport = clone_wrapper(transport)
                    transport._timeout_sec = VIDEO_SEND_TIMEOUT_SECONDS
                    setattr(api, name, transport)
            call_action = api.call_action
        result = await asyncio.wait_for(call_action(
            action, **destination,
            message=[{'type': 'video', 'data': {'file': video_url}}],
            timeout=VIDEO_SEND_TIMEOUT_SECONDS * 1000,
        ), timeout=VIDEO_SEND_TIMEOUT_SECONDS)
        if not isinstance(result, dict):
            raise RuntimeError('QQ 视频接口未返回消息回执')
        if result.get('status') == 'failed' or result.get('retcode', 0) not in (0, None):
            raise RuntimeError('QQ 视频接口返回失败：' + str(
                result.get('wording') or result.get('message') or result.get('retcode')))
        receipt = result.get('data') if isinstance(result.get('data'), dict) else result
        if not receipt.get('message_id'):
            raise RuntimeError('QQ 视频接口未返回消息回执')
        return receipt

    async def forward_video(self, target: Target, message_id):
        """NapCat returns null only after native forwardMsg reports result=0."""
        if not self.capabilities.native_forward:
            raise VideoForwardRejected('native_forward unsupported')
        bot = self.bot
        action, destination = self.destination(target)
        try:
            result = await asyncio.wait_for(bot.call_action(
                'forward_group_single_msg', message_id=message_id,
                group_id=str(destination['group_id']),
            ), timeout=30)
        except Exception as error:
            # aiocqhttp raises ActionFailed for an explicit non-zero retcode.
            # A transport timeout is uncertain and must never trigger a resend.
            if getattr(error, 'retcode', None) not in (None, 0):
                raise VideoForwardRejected(str(error)) from error
            raise
        if isinstance(result, dict) and (
            result.get('status') == 'failed' or result.get('retcode', 0) not in (0, None)
        ):
            raise VideoForwardRejected('QQ 原生转发接口明确返回失败')
        receipt = result.get('data', result) if isinstance(result, dict) else result
        # The deployed API returns None; some versions return a message receipt.
        if receipt is not None and not (isinstance(receipt, dict) and receipt.get('message_id')):
            raise RuntimeError('QQ 原生转发接口返回了未知结果')
        return {**(receipt or {}), 'delivery': 'native-forward', 'reused_message_id': message_id}

class OneBotAdapter(LegacyOneBotAdapter):
    """Validated delivery path, opt-in until live verification is complete."""

    async def _deliver(self, operation, awaitable):
        try:
            result = await awaitable
        except asyncio.CancelledError:
            raise
        except Exception as error:
            code = getattr(error, 'retcode', None)
            raise DeliveryError(operation, 'rejected' if code not in (None, 0) else 'unknown', code or '') from error
        receipt = delivery_receipt(result)
        if receipt.outcome != 'success':
            raise DeliveryError(operation, receipt.outcome, receipt.code)
        return result

    async def send(self, target, message):
        return await self._deliver('send', super().send(target, message))

    async def send_forward(self, target, nodes):
        self.require('send_forwards')
        return await self._deliver('send_forward', super().send_forward(target, nodes))
