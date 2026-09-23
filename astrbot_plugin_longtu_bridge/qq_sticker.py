"""Preserve QQ's sticker subtype through AstrBot's OneBot serializer."""

from astrbot.api.message_components import BaseMessageComponent, ComponentType


class QqSticker(BaseMessageComponent):
    # AstrBot's Image branch rebuilds the segment with only `file`, discarding
    # sub_type. A dedicated component uses its ordinary toDict path instead.
    type: ComponentType = ComponentType.Image
    file: str

    def toDict(self):
        return {
            "type": "image",
            "data": {"file": self.file, "sub_type": 1, "summary": "[龙图]"},
        }
