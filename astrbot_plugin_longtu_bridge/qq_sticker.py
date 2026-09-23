"""QQ sticker transport data, delivered directly by the bridge via OneBot."""

from astrbot.api.message_components import BaseMessageComponent, ComponentType


class QqSticker(BaseMessageComponent):
    # AstrBot's Image serializer drops sub_type, while RespondStage rejects
    # custom-only chains as empty. Never yield this component to that stage;
    # _deliver_reply_chains sends its dictionary through OneBot directly.
    type: ComponentType = ComponentType.Image
    file: str

    def toDict(self):
        return {
            "type": "image",
            "data": {"file": self.file, "sub_type": 1, "summary": "[龙图]"},
        }
