"""The bridge must not copy a third party @ into its reply prefix."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest


SOURCE = ast.parse(
    (Path(__file__).resolve().parents[1] / "astrbot_plugin_longtu_bridge/main.py").read_text(),
)
BRIDGE = next(
    node for node in SOURCE.body
    if isinstance(node, ast.ClassDef) and node.name == "LongtuQqBridge"
)
METHOD_NAMES = {"_is_explicitly_at_bot", "_reply_prefix"}
METHODS = [node for node in BRIDGE.body if getattr(node, "name", "") in METHOD_NAMES]


class At:
    def __init__(self, qq, name=""):
        self.qq = qq
        self.name = name


class Reply:
    def __init__(self, id):
        self.id = id


class Plain:
    def __init__(self, text):
        self.text = text


namespace = {
    "AstrMessageEvent": object,
    "Comp": SimpleNamespace(At=At, Reply=Reply, Plain=Plain),
}
module = ast.Module(
    body=[ast.ClassDef(
        name="Bridge",
        bases=[],
        keywords=[],
        body=METHODS,
        decorator_list=[],
    )],
    type_ignores=[],
)
exec(compile(ast.fix_missing_locations(module), "<reply-prefix>", "exec"), namespace)
Bridge = namespace["Bridge"]


class ReplyPrefixTests(unittest.TestCase):
    def event(self):
        return SimpleNamespace(
            is_private_chat=lambda: False,
            message_obj=SimpleNamespace(message_id="message-1"),
            get_self_id=lambda: "self",
            get_sender_id=lambda: "asker",
            get_sender_name=lambda: "提问者",
            get_messages=lambda: [],
        )

    def test_only_sender_is_mentioned_when_bot_is_explicitly_addressed(self):
        event = self.event()
        event.get_messages = lambda: [
            At("peer-bot", "另一个 Bot"),
            At("self", "龙玉涛"),
        ]

        prefix = Bridge._reply_prefix(event, event.get_messages())

        self.assertEqual([type(item) for item in prefix], [Reply, At, Plain])
        self.assertEqual(prefix[1].qq, "asker")
        self.assertEqual(prefix[1].name, "提问者")

    def test_third_party_mention_is_not_copied_without_bot_mention(self):
        event = self.event()
        components = [At("peer-bot", "另一个 Bot")]

        prefix = Bridge._reply_prefix(event, components)

        self.assertEqual([type(item) for item in prefix], [Reply])


if __name__ == "__main__":
    unittest.main()
