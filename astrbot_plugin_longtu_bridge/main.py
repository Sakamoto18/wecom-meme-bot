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
    "1.1.0",
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

    @staticmethod
    def _enabled(value, default: bool = False) -> bool:
        if value is None or str(value).strip() == "":
            return default
        return str(value).strip().lower() not in {"0", "false", "off", "no"}

    def _group_is_allowed(self, event: AstrMessageEvent) -> bool:
        if event.is_private_chat():
            return True
        allowed_groups = self._allowed_groups()
        return not allowed_groups or event.get_group_id() in allowed_groups

    @staticmethod
    def _is_explicitly_at_bot(event: AstrMessageEvent) -> bool:
        bot_user_id = str(event.get_self_id() or "").strip()
        if not bot_user_id:
            return False
        return any(
            isinstance(component, Comp.At)
            and str(getattr(component, "qq", "") or "").strip() == bot_user_id
            for component in event.get_messages()
        )

    def _should_reply(self, event: AstrMessageEvent) -> bool:
        if event.is_private_chat():
            return True
        if not self._group_is_allowed(event):
            return False
        ignore_slash_commands = self._enabled(
            os.getenv("LONGTU_QQ_IGNORE_SLASH_COMMANDS")
            if os.getenv("LONGTU_QQ_IGNORE_SLASH_COMMANDS") is not None
            else self.config.get("ignore_slash_commands", True),
            True,
        )
        normalized_text = event.message_str.strip().lower()
        if ignore_slash_commands and normalized_text.startswith("/"):
            return False
        ignored_commands = (
            os.getenv("LONGTU_QQ_IGNORED_WAKE_COMMANDS")
            or self.config.get("ignored_wake_commands")
            or "/w"
        )
        ignored = {
            command.strip().lower()
            for command in str(ignored_commands).split(",")
            if command.strip()
        }
        if normalized_text in ignored:
            return False
        reply_only_when_at = self._enabled(
            os.getenv("LONGTU_QQ_REPLY_ONLY_WHEN_AT")
            if os.getenv("LONGTU_QQ_REPLY_ONLY_WHEN_AT") is not None
            else self.config.get("reply_only_when_at", True),
            True,
        )
        if reply_only_when_at:
            return self._is_explicitly_at_bot(event)
        reply_only_when_waked = bool(
            self.config.get("reply_only_when_waked", True),
        )
        return not reply_only_when_waked or event.is_at_or_wake_command

    def _should_observe(self, event: AstrMessageEvent) -> bool:
        if event.is_private_chat() or not self._group_is_allowed(event):
            return False
        ignore_slash_commands = self._enabled(
            os.getenv("LONGTU_QQ_IGNORE_SLASH_COMMANDS")
            if os.getenv("LONGTU_QQ_IGNORE_SLASH_COMMANDS") is not None
            else self.config.get("ignore_slash_commands", True),
            True,
        )
        if ignore_slash_commands and event.message_str.strip().startswith("/"):
            return False
        configured = os.getenv("LONGTU_QQ_OBSERVE_GROUP_MESSAGES")
        if configured is None:
            configured = self.config.get("observe_group_messages", True)
        return self._enabled(configured, True)

    @staticmethod
    def _quoted_text(components: list) -> str:
        for component in components:
            if isinstance(component, Comp.Reply):
                return str(getattr(component, "message_str", "") or "").strip()
        return ""

    @staticmethod
    def _mentions(components: list) -> list[dict]:
        mentions = []
        seen = set()
        for component in components:
            if not isinstance(component, Comp.At):
                continue
            user_id = str(getattr(component, "qq", "") or "").strip()
            if not user_id or user_id.lower() == "all" or user_id in seen:
                continue
            seen.add(user_id)
            mentions.append({
                "user_id": user_id,
                "name": str(getattr(component, "name", "") or "").strip(),
            })
        return mentions

    @staticmethod
    def _reply_component(components: list):
        for component in components:
            if isinstance(component, Comp.Reply):
                return component
        return None

    @staticmethod
    def _quoted_author(reply_component) -> tuple[str, str]:
        if not reply_component:
            return "", ""
        user_id = str(
            getattr(reply_component, "sender_id", "")
            or getattr(reply_component, "user_id", "")
            or ""
        ).strip()
        name = str(
            getattr(reply_component, "sender_nickname", "")
            or getattr(reply_component, "sender_name", "")
            or ""
        ).strip()
        return user_id, name

    @staticmethod
    async def _image_base64(image_component) -> str:
        if not image_component:
            return ""
        converted = await image_component.convert_to_base64()
        if isinstance(converted, str):
            return converted.removeprefix("base64://")
        for attribute in ("base64", "file"):
            value = str(getattr(converted, attribute, "") or "")
            if value.startswith("base64://"):
                return value.removeprefix("base64://")
        return ""

    @classmethod
    async def _first_image_base64(cls, components: list) -> str:
        for component in components:
            if isinstance(component, Comp.Image):
                return await cls._image_base64(component)
        return ""

    @classmethod
    async def _quoted_image_base64(cls, reply_component) -> str:
        chain = getattr(reply_component, "chain", None) or []
        return await cls._first_image_base64(chain)

    @staticmethod
    def _is_image_management_text(text: str) -> bool:
        normalized = str(text or "").replace(" ", "")
        return (
            ("龙图" in normalized or "图库" in normalized)
            and any(keyword in normalized for keyword in (
                "添加", "加入", "存入", "保存", "删除", "删掉", "移除", "强制",
            ))
        )

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
        """回复唤醒消息，并静默观察允许群中的普通消息。"""
        should_reply = self._should_reply(event)
        observe_only = not should_reply and self._should_observe(event)
        if not should_reply and not observe_only:
            return

        components = event.get_messages()
        text = event.message_str.strip()
        has_image = any(isinstance(component, Comp.Image) for component in components)
        if not text and not has_image:
            return

        if should_reply:
            event.stop_event()
        if should_reply and bool(self.config.get("send_processing_hint", False)) and text:
            yield event.plain_result("正在翻龙图小本本……")

        reply_component = self._reply_component(components)
        quoted_user_id, quoted_sender_name = self._quoted_author(reply_component)
        image_base64 = ""
        quoted_image_base64 = ""
        if should_reply and self._is_image_management_text(text):
            try:
                image_base64 = await self._first_image_base64(components)
                quoted_image_base64 = await self._quoted_image_base64(reply_component)
            except Exception as error:
                logger.warning(f"龙图库管理图片读取失败：{error}")

        bot_user_id = str(event.get_self_id() or "").strip()

        payload = {
            "message_id": str(event.message_obj.message_id or ""),
            "message_type": "private" if event.is_private_chat() else "group",
            "group_id": event.get_group_id(),
            "user_id": event.get_sender_id(),
            "sender_name": event.get_sender_name(),
            "text": text,
            "quoted_text": self._quoted_text(components),
            "quoted_user_id": quoted_user_id,
            "quoted_sender_name": quoted_sender_name,
            "mentions": self._mentions(components),
            "bot_user_id": bot_user_id,
            "has_image": has_image,
            "image_base64": image_base64,
            "quoted_image_base64": quoted_image_base64,
            "observe_only": observe_only,
        }

        try:
            response = await self._request_backend(payload)
        except Exception as error:
            logger.error(f"龙图 QQ Bridge 请求失败：{error}")
            if observe_only:
                return
            error_message = self.config.get(
                "error_message",
                "龙图服务暂时不可用，请稍后再试。",
            )
            yield event.plain_result(str(error_message))
            return

        if observe_only:
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
