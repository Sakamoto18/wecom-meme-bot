from __future__ import annotations
"""OneBot event/component decoding, including raw quote and sticker metadata."""
import re
import astrbot.api.message_components as Comp
from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent


class OneBotCodec:
    @staticmethod
    def _raw_text(event: AstrMessageEvent) -> str:
        """读取 WakingCheck 修改前的原始文字，避免斜杠唤醒词被剥掉。"""
        raw_message = getattr(getattr(event, "message_obj", None), "raw_message", None)
        if isinstance(raw_message, dict):
            segments = raw_message.get("message")
            if isinstance(segments, list):
                text_parts = []
                for segment in segments:
                    if not isinstance(segment, dict) or segment.get("type") != "text":
                        continue
                    data = segment.get("data")
                    if isinstance(data, dict):
                        text_parts.append(str(data.get("text") or ""))
                segment_text = "".join(text_parts).strip()
                if segment_text:
                    return segment_text
            raw_text = raw_message.get("raw_message")
            if isinstance(raw_text, str) and raw_text.strip():
                return re.sub(r"\[CQ:[^\]]+\]", "", raw_text).strip()
        return ""

    @staticmethod
    def _rich_segments_from_components(components: list) -> list[dict]:
        result = []
        for component in components or []:
            component_type = str(getattr(component, "type", "") or "").lower()
            if component_type == "video" or isinstance(component, getattr(Comp, "Video", ())):
                url = str(getattr(component, "url", "") or getattr(component, "file", "") or "").strip()
                if url.startswith(("http://", "https://")):
                    result.append({"type": "video", "data": {"url": url}})
                continue
            if component_type not in {"json", "xml"} and not isinstance(
                component,
                (Comp.Json, getattr(Comp, "Xml", Comp.Json)),
            ):
                continue
            data = getattr(component, "data", None)
            if isinstance(data, (dict, str)) and len(str(data)) <= 256 * 1024:
                item = {"type": component_type or "json", "data": data}
                if item not in result:
                    result.append(item)
        return result

    @classmethod
    def _rich_segments(
        cls,
        event: AstrMessageEvent,
        extra_components: list | None = None,
    ) -> list[dict]:
        """保留 OneBot json/xml 卡片原文；卡片正文通常不在 Plain 组件里。"""
        raw_message = getattr(getattr(event, "message_obj", None), "raw_message", None)
        segments = raw_message.get("message") if isinstance(raw_message, dict) else None
        result = []
        if isinstance(segments, list):
            for segment in segments:
                if not isinstance(segment, dict) or str(segment.get("type") or "").lower() not in {"json", "xml"}:
                    continue
                data = segment.get("data")
                if not isinstance(data, dict):
                    continue
                # QQ 卡片的真实 jumpurl/qqdocurl 常位于 data/content 的更深层，
                # 不能只保留少数展示字段，否则会把完整地址降级成标题里的“it…”。
                if len(str(data)) <= 256 * 1024:
                    result.append({"type": str(segment.get("type")).lower(), "data": data})
        # AstrBot 4.x often converts OneBot JSON cards into Comp.Json before
        # exposing the event. In that path raw_message can be empty. Quoted
        # messages use the same component path after get_msg backfill.
        for item in cls._rich_segments_from_components([
            *(event.get_messages() or []),
            *(extra_components or []),
        ]):
            if item not in result:
                result.append(item)
        return result[:8]

    @staticmethod
    def _components_from_raw_message(segments) -> list:
        """把 OneBot get_msg 返回的原始消息段转换成 AstrBot 组件。"""
        if not isinstance(segments, list):
            return []
        components = []
        for segment in segments:
            if not isinstance(segment, dict):
                continue
            segment_type = str(segment.get("type") or "").lower()
            data = segment.get("data") if isinstance(segment.get("data"), dict) else {}
            if segment_type == "forward":
                forward_id = str(
                    data.get("id") or data.get("message_id") or "",
                ).strip()
                if forward_id:
                    components.append(Comp.Forward(id=forward_id))
            elif segment_type == "reply":
                reply_id = str(
                    data.get("id") or data.get("message_id") or "",
                ).strip()
                if reply_id:
                    components.append(Comp.Reply(id=reply_id))
            elif segment_type == "image":
                reference = str(
                    data.get("url") or data.get("file") or data.get("file_id") or "",
                ).strip()
                if reference:
                    image = Comp.Image(file=reference)
                    # AstrBot 的 Image 组件通常不会暴露 OneBot 的 sub_type。
                    # 暂存到组件上，后续只过滤我们发出的 QQ 龙图表情
                    #（sub_type=1），普通分享卡/总结图仍可被视觉模型读取。
                    for attribute, value in (
                        ("_longtu_image_sub_type", data.get("sub_type")),
                        ("_longtu_image_summary", data.get("summary")),
                    ):
                        if value is None or value == "":
                            continue
                        try:
                            setattr(image, attribute, value)
                        except Exception:
                            # 某些 AstrBot 版本的组件模型禁止动态字段；
                            # _quoted_message_chain 还会把原始 sub_type
                            # 写到 Reply 上作为兜底。
                            pass
                    components.append(image)
            elif segment_type == "text":
                text = str(data.get("text") or "")
                if text:
                    components.append(Comp.Plain(text))
            elif segment_type in {"json", "xml"}:
                card = data.get("data") or data.get("content") or data
                try:
                    components.append(Comp.Json(card if isinstance(card, dict) else str(card)))
                except Exception:
                    logger.debug("引用卡片组件转换失败")
        return components
