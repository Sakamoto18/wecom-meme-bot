import asyncio
import os
import time

import aiohttp

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
import astrbot.api.message_components as Comp
from astrbot.api.star import Context, Star, register


MAX_FORWARD_NODES = 30
MAX_FORWARD_CHARACTERS = 8000
MAX_FORWARD_NODE_CHARACTERS = 600
MAX_FORWARD_DEPTH = 2
FORWARD_CACHE_TTL_SECONDS = 60 * 60
FORWARD_CACHE_MAX_ENTRIES = 128


@register(
    "astrbot_plugin_longtu_bridge",
    "Sakamoto18",
    "把 AstrBot 的 QQ 消息转发给本项目的独立 QQ Bot 服务",
    "1.3.0",
)
class LongtuQqBridge(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        self.session: aiohttp.ClientSession | None = None
        self.forward_cache: dict[str, tuple[float, str]] = {}

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
    def _forward_components(components: list) -> list:
        return [
            component
            for component in components
            if isinstance(component, Comp.Forward)
        ]

    @staticmethod
    def _compact_forward_value(value, limit: int) -> str:
        return " ".join(str(value or "").split()).strip()[:limit]

    @classmethod
    def _format_forward_segments(
        cls,
        segments,
        depth: int,
        budget: dict,
    ) -> str:
        if isinstance(segments, str):
            return cls._compact_forward_value(
                segments,
                MAX_FORWARD_NODE_CHARACTERS,
            )
        if not isinstance(segments, list):
            return ""

        parts = []
        placeholders = {
            "image": "[图片]",
            "mface": "[表情]",
            "face": "[表情]",
            "record": "[语音]",
            "video": "[视频]",
            "file": "[文件]",
            "json": "[卡片消息]",
            "xml": "[卡片消息]",
            "reply": "[引用消息]",
        }
        for segment in segments:
            if isinstance(segment, str):
                text = cls._compact_forward_value(segment, MAX_FORWARD_NODE_CHARACTERS)
                if text:
                    parts.append(text)
                continue
            if not isinstance(segment, dict):
                continue
            segment_type = str(segment.get("type") or "").lower()
            data = segment.get("data") if isinstance(segment.get("data"), dict) else {}
            if segment_type == "text":
                text = cls._compact_forward_value(
                    data.get("text"),
                    MAX_FORWARD_NODE_CHARACTERS,
                )
                if text:
                    parts.append(text)
            elif segment_type == "at":
                name = cls._compact_forward_value(data.get("name"), 40)
                parts.append(f"@{name}" if name else "@某人")
            elif segment_type == "forward":
                nested = data.get("content")
                if depth >= MAX_FORWARD_DEPTH or not isinstance(nested, list):
                    parts.append("[嵌套合并转发]")
                    continue
                nested_text = cls._format_forward_nodes(
                    nested,
                    depth + 1,
                    budget,
                )
                parts.append(
                    f"[嵌套合并转发：{nested_text.replace(chr(10), ' / ')}]"
                    if nested_text
                    else "[嵌套合并转发]"
                )
            elif segment_type in {"node", "nodes"}:
                nested = data.get("content") or data.get("message") or data.get("messages")
                nested_text = cls._format_forward_nodes(
                    nested if isinstance(nested, list) else [],
                    depth + 1,
                    budget,
                )
                if nested_text:
                    parts.append(nested_text.replace("\n", " / "))
            elif segment_type in placeholders:
                parts.append(placeholders[segment_type])
            else:
                summary = cls._compact_forward_value(
                    data.get("summary") or data.get("text"),
                    80,
                )
                if summary:
                    parts.append(summary)

            if sum(len(part) for part in parts) >= MAX_FORWARD_NODE_CHARACTERS:
                break

        return " ".join(parts).strip()[:MAX_FORWARD_NODE_CHARACTERS]

    @classmethod
    def _format_forward_nodes(
        cls,
        nodes,
        depth: int = 0,
        budget: dict | None = None,
    ) -> str:
        if not isinstance(nodes, list) or depth > MAX_FORWARD_DEPTH:
            return ""
        if budget is None:
            budget = {"nodes": 0, "truncated": False}
        lines = []
        for node in nodes:
            if budget["nodes"] >= MAX_FORWARD_NODES:
                budget["truncated"] = True
                break
            if not isinstance(node, dict):
                continue

            budget["nodes"] += 1
            if str(node.get("type") or "").lower() == "node":
                node_data = node.get("data") if isinstance(node.get("data"), dict) else {}
                name = node_data.get("nickname") or node_data.get("name")
                segments = (
                    node_data.get("message")
                    or node_data.get("content")
                    or []
                )
            else:
                sender = node.get("sender") if isinstance(node.get("sender"), dict) else {}
                name = (
                    sender.get("card")
                    or sender.get("nickname")
                    or node.get("nickname")
                    or node.get("name")
                )
                segments = node.get("message") or node.get("content") or []

            display_name = cls._compact_forward_value(name, 40) or "未知成员"
            content = cls._format_forward_segments(segments, depth, budget)
            lines.append(f"{display_name}：{content or '[非文本消息]'}")

        if depth == 0 and budget.get("truncated"):
            lines.append(f"（仅展开前 {MAX_FORWARD_NODES} 条消息）")
        formatted = "\n".join(lines)
        if len(formatted) > MAX_FORWARD_CHARACTERS:
            formatted = formatted[:MAX_FORWARD_CHARACTERS].rstrip()
            formatted += "\n（转发内容过长，已截断）"
        return formatted

    async def _fetch_forward_text(
        self,
        event: AstrMessageEvent,
        forward_id: str,
    ) -> str:
        normalized_id = str(forward_id or "").strip()
        if not normalized_id:
            return ""
        now = time.monotonic()
        cached = self.forward_cache.get(normalized_id)
        if cached and now - cached[0] <= FORWARD_CACHE_TTL_SECONDS:
            return cached[1]

        bot = getattr(event, "bot", None)
        if not bot or not callable(getattr(bot, "call_action", None)):
            logger.warning("当前 QQ 事件没有可用的 OneBot API 客户端，无法展开合并转发")
            return ""
        routing_params = {}
        self_id = str(getattr(event.message_obj, "self_id", "") or "").strip()
        if self_id:
            routing_params["self_id"] = self_id
        try:
            result = await asyncio.wait_for(
                bot.call_action(
                    action="get_forward_msg",
                    message_id=normalized_id,
                    **routing_params,
                ),
                timeout=20,
            )
        except Exception as error:
            logger.warning(f"合并转发内容展开失败：{type(error).__name__}")
            return ""

        nodes = result.get("messages") if isinstance(result, dict) else None
        formatted = self._format_forward_nodes(nodes)
        if not formatted:
            logger.warning("合并转发 API 未返回可解析的消息节点")
            return ""

        self.forward_cache[normalized_id] = (now, formatted)
        if len(self.forward_cache) > FORWARD_CACHE_MAX_ENTRIES:
            oldest_id = min(
                self.forward_cache,
                key=lambda key: self.forward_cache[key][0],
            )
            self.forward_cache.pop(oldest_id, None)
        logger.info(f"已展开合并转发内容，共 {formatted.count(chr(10)) + 1} 行")
        return formatted

    async def _forwarded_text(
        self,
        event: AstrMessageEvent,
        components: list,
    ) -> str:
        texts = []
        seen = set()
        for component in self._forward_components(components):
            forward_id = str(getattr(component, "id", "") or "").strip()
            if not forward_id or forward_id in seen:
                continue
            seen.add(forward_id)
            text = await self._fetch_forward_text(event, forward_id)
            if text:
                texts.append(text)
        return "\n\n".join(texts)[:MAX_FORWARD_CHARACTERS]

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
        library_management = (
            ("龙图" in normalized or "图库" in normalized)
            and any(keyword in normalized for keyword in (
                "添加", "加入", "存入", "保存", "删除", "删掉", "移除", "强制",
            ))
        )
        alias_binding = (
            ("这张图" in normalized or "这个图" in normalized or "这张图片" in normalized)
            and any(keyword in normalized for keyword in (
                "绑定", "关联", "设为", "设置", "指定", "固定", "调用", "使用",
            ))
        )
        return library_management or alias_binding

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
        reply_component = self._reply_component(components)
        quoted_chain = getattr(reply_component, "chain", None) or []
        has_forward = bool(
            self._forward_components(components)
            or self._forward_components(quoted_chain)
        )
        if not text and not has_image and not has_forward:
            return

        if should_reply:
            event.stop_event()
        if should_reply and bool(self.config.get("send_processing_hint", False)) and text:
            yield event.plain_result("正在翻龙图小本本……")

        quoted_user_id, quoted_sender_name = self._quoted_author(reply_component)
        forwarded_text = await self._forwarded_text(event, components)
        quoted_forwarded_text = await self._forwarded_text(event, quoted_chain)
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
            "forwarded_text": forwarded_text,
            "quoted_forwarded_text": quoted_forwarded_text,
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
