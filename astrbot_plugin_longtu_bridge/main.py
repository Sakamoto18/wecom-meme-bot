import os

import aiohttp

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
import astrbot.api.message_components as Comp
from astrbot.api.star import Context, Star, register


@register(
    "astrbot_plugin_longtu_bridge",
    "Sakamoto18",
    "把 AstrBot 的 QQ 消息转发给本项目的独立 QQ Bot 服务",
    "1.0.0",
)
class LongtuQqBridge(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        self.session: aiohttp.ClientSession | None = None

    async def initialize(self):
        timeout_seconds = max(
            10,
            int(self.config.get("request_timeout_seconds", 190)),
        )
        self.session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=timeout_seconds),
        )

    def _api_url(self) -> str:
        return (
            os.getenv("LONGTU_QQ_API_URL")
            or self.config.get("api_url")
            or "http://qq-bot:8787/v1/qq/message"
        ).strip()

    def _api_token(self) -> str:
        return (
            os.getenv("LONGTU_QQ_API_TOKEN")
            or self.config.get("api_token")
            or ""
        ).strip()

    def _allowed_groups(self) -> set[str]:
        configured = (
            os.getenv("LONGTU_QQ_ALLOWED_GROUPS")
            or self.config.get("allowed_groups")
            or ""
        )
        return {
            group_id.strip()
            for group_id in str(configured).split(",")
            if group_id.strip()
        }

    def _should_handle(self, event: AstrMessageEvent) -> bool:
        if event.is_private_chat():
            return True

        allowed_groups = self._allowed_groups()
        if allowed_groups and event.get_group_id() not in allowed_groups:
            return False

        reply_only_when_waked = bool(
            self.config.get("reply_only_when_waked", True),
        )
        return not reply_only_when_waked or event.is_at_or_wake_command

    @staticmethod
    def _quoted_text(components: list) -> str:
        for component in components:
            if isinstance(component, Comp.Reply):
                return str(getattr(component, "message_str", "") or "").strip()
        return ""

    async def _request_backend(self, payload: dict) -> dict:
        if not self.session or self.session.closed:
            raise RuntimeError("HTTP 客户端尚未初始化")
        token = self._api_token()
        if not token:
            raise RuntimeError("插件缺少 api_token / LONGTU_QQ_API_TOKEN")

        async with self.session.post(
            self._api_url(),
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        ) as response:
            if response.status != 200:
                detail = (await response.text())[:500]
                raise RuntimeError(
                    f"QQ Bot API 返回 HTTP {response.status}: {detail}",
                )
            body = await response.json(content_type=None)
            if not body.get("ok") or not isinstance(body.get("messages"), list):
                raise RuntimeError("QQ Bot API 返回格式无效")
            return body

    @filter.platform_adapter_type(filter.PlatformAdapterType.AIOCQHTTP)
    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_qq_message(self, event: AstrMessageEvent):
        """处理 NapCat/OneBot v11 的 QQ 私聊和被唤醒的群聊消息。"""
        if not self._should_handle(event):
            return

        components = event.get_messages()
        text = event.message_str.strip()
        has_image = any(isinstance(component, Comp.Image) for component in components)
        if not text and not has_image:
            return

        event.stop_event()
        if bool(self.config.get("send_processing_hint", False)) and text:
            yield event.plain_result("正在翻龙图小本本……")

        payload = {
            "message_id": str(event.message_obj.message_id or ""),
            "message_type": "private" if event.is_private_chat() else "group",
            "group_id": event.get_group_id(),
            "user_id": event.get_sender_id(),
            "sender_name": event.get_sender_name(),
            "text": text,
            "quoted_text": self._quoted_text(components),
            "has_image": has_image,
        }

        try:
            response = await self._request_backend(payload)
        except Exception as error:
            logger.error(f"龙图 QQ Bridge 请求失败：{error}")
            error_message = self.config.get(
                "error_message",
                "龙图服务暂时不可用，请稍后再试。",
            )
            yield event.plain_result(str(error_message))
            return

        reply_chain = []
        for message in response["messages"]:
            message_type = message.get("type")
            if message_type == "text" and message.get("text"):
                reply_chain.append(Comp.Plain(str(message["text"])))
            elif message_type == "image" and message.get("base64"):
                reply_chain.append(
                    Comp.Image.fromBase64(str(message["base64"])),
                )

        # AstrBot only consumes one result from this handler in the normal
        # response pipeline. Keep text and the attached meme in one chain so
        # the image is not dropped after the text response has been sent.
        if reply_chain:
            yield event.chain_result(reply_chain)

    async def terminate(self):
        if self.session and not self.session.closed:
            await self.session.close()
