"""Execute the actual bridge methods with a recording OneBot client."""
import ast
import asyncio
import logging
from pathlib import Path
from types import SimpleNamespace
import unittest

source = ast.parse((Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/main.py').read_text())
bridge = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
methods = [n for n in bridge.body if getattr(n, 'name', '') in (
    '_reply_chain_from_backend', '_reply_chains_from_backend', '_send_forward_from_backend', '_send_media_limit_card',
)]

class Component:
    def __init__(self, *args, **kwargs): self.args, self.kwargs = args, kwargs
class Image(Component):
    @classmethod
    def fromBase64(cls, value): return cls(value)
class Video(Component): pass
class Plain(Component): pass

class BaseMessageComponent:
    def __init__(self, **kwargs): self.__dict__.update(kwargs)
sticker_source = ast.parse((Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/qq_sticker.py').read_text())
sticker_class = next(n for n in sticker_source.body if isinstance(n, ast.ClassDef))
sticker_namespace = {'BaseMessageComponent': BaseMessageComponent,
                     'ComponentType': SimpleNamespace(Image='Image')}
exec(compile(ast.fix_missing_locations(ast.Module(body=[sticker_class], type_ignores=[])), '<qq-sticker>', 'exec'), sticker_namespace)
QqSticker = sticker_namespace['QqSticker']

namespace = {'AstrMessageEvent': object, 'logger': logging.getLogger('test'), 'asyncio': asyncio,
             'Comp': SimpleNamespace(Image=Image, Video=Video, Plain=Plain), 'QqSticker': QqSticker}
exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='Bridge', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])), '<bridge-methods>', 'exec'), namespace)
Bridge = namespace['Bridge']
async def fake_card(self, message):
    if message.get('images'):
        assert message['coverUrl'] == message['images'][0]
    assert message['title'] == '测试'
    assert message['description'] == '#英语#'
    return 'card-png-base64'
Bridge._video_card = fake_card

class DeliveryTests(unittest.IsolatedAsyncioTestCase):
    def event(self, private=False, fail_forward=False):
        calls = []
        async def call_action(action, **kwargs):
            calls.append((action, kwargs))
            if fail_forward and 'forward' in action: return {'status': 'failed', 'retcode': 1200}
            return {'message_id': 123}
        event = SimpleNamespace(bot=SimpleNamespace(call_action=call_action),
            is_private_chat=lambda: private, get_group_id=lambda: '361522110',
            get_sender_id=lambda: '1079175957', get_self_id=lambda: '2170902293')
        return event, calls

    def gallery(self):
        return {'mode': 'media-gallery', 'messages': [{'type': 'forward', 'title': '测试',
            'description': '#英语#', 'images': ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg']}]}

    async def test_group_images_use_one_forward_with_image_nodes(self):
        event, calls = self.event()
        self.assertTrue(await Bridge()._send_forward_from_backend(event, self.gallery()))
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][0], 'send_group_msg')
        self.assertEqual(calls[0][1]['message'][0]['data']['file'], 'base64://card-png-base64')
        action, kwargs = calls[1]
        self.assertEqual(action, 'send_group_forward_msg')
        nodes = kwargs['messages']
        self.assertEqual(len(nodes), 2)
        self.assertEqual([n['data']['content'][0]['type'] for n in nodes], ['image', 'image'])
        self.assertEqual([n['data']['content'][0]['data']['file'] for n in nodes], self.gallery()['messages'][0]['images'])

    async def test_private_images_use_private_forward(self):
        event, calls = self.event(private=True)
        self.assertTrue(await Bridge()._send_forward_from_backend(event, self.gallery()))
        self.assertEqual(calls[1][0], 'send_private_forward_msg')
        self.assertEqual(calls[1][1]['user_id'], 1079175957)
        self.assertNotIn('group_id', calls[1][1])

    async def test_video_never_enters_forward_sender(self):
        event, calls = self.event()
        response = {'mode': 'media', 'messages': [{'type': 'video', 'url': 'https://cdn.example/720.mp4', 'title': '视频标题'}]}
        self.assertFalse(await Bridge()._send_forward_from_backend(event, response))
        self.assertEqual(calls, [])
        chain = Bridge._reply_chain_from_backend(response)
        self.assertEqual([type(item) for item in chain], [Video])

    def test_removed_share_message_is_kept_for_delivery(self):
        response = {
            'mode': 'media-unavailable',
            'messages': [{'type': 'text', 'text': '这个分享的内容已被删除，无法抓取。'}],
        }
        chain = Bridge._reply_chain_from_backend(response)
        self.assertEqual([type(item) for item in chain], [Plain])
        self.assertEqual(chain[0].args, ('这个分享的内容已被删除，无法抓取。',))

    async def test_failed_forward_falls_back_to_images_not_links(self):
        event, calls = self.event(fail_forward=True)
        self.assertTrue(await Bridge()._send_forward_from_backend(event, self.gallery()))
        self.assertEqual([c[0] for c in calls], ['send_group_msg', 'send_group_forward_msg', 'send_group_msg', 'send_group_msg'])
        self.assertEqual(calls[-1][1]['message'][0]['type'], 'image')

    async def test_transient_forward_timeout_is_retried(self):
        calls = []
        failed_once = True

        async def call_action(action, **kwargs):
            nonlocal failed_once
            calls.append((action, kwargs))
            if action == 'send_group_forward_msg' and failed_once:
                failed_once = False
                raise RuntimeError('WebSocket API call timeout')
            return {'message_id': 123}

        event = SimpleNamespace(
            bot=SimpleNamespace(call_action=call_action),
            is_private_chat=lambda: False, get_group_id=lambda: '361522110',
            get_sender_id=lambda: '1079175957', get_self_id=lambda: '2170902293',
        )
        self.assertTrue(await Bridge()._send_forward_from_backend(event, self.gallery()))
        self.assertEqual([action for action, _ in calls], [
            'send_group_msg', 'send_group_forward_msg', 'send_group_forward_msg',
        ])

    async def test_media_limit_sends_cover_before_limit_text(self):
        event, calls = self.event()
        response = {'mode': 'media-unavailable', 'messages': [{
            'type': 'media-limit', 'text': '视频提取超过 8 分钟，已中断。',
            'title': '测试', 'description': '#英语#',
            'coverUrl': 'https://cdn.example/cover.jpg', 'provider': 'bilibili',
        }]}
        self.assertTrue(await Bridge()._send_media_limit_card(event, response))
        self.assertEqual(calls[0][0], 'send_group_msg')
        self.assertEqual(calls[0][1]['message'][0]['data']['file'], 'base64://card-png-base64')
        chain = Bridge._reply_chain_from_backend(response)
        self.assertEqual(chain[0].args, ('视频提取超过 8 分钟，已中断。',))

    def test_final_gallery_fallback_uses_native_images(self):
        chain = Bridge._reply_chain_from_backend(self.gallery())
        self.assertEqual([type(c) for c in chain], [Image, Image])

    def test_text_parts_stay_separate_and_image_is_last_part(self):
        response = {'messages': [
            {'type': 'text', 'text': '第一条结论'},
            {'type': 'text', 'text': '第二条条件'},
            {'type': 'image', 'base64': 'dragon'},
        ]}
        chains = Bridge._reply_chains_from_backend(response)
        self.assertEqual(len(chains), 3)
        self.assertEqual(chains[0][0].args, ('第一条结论',))
        self.assertEqual(chains[1][0].args, ('第二条条件',))
        self.assertIsInstance(chains[2][0], Image)

    def test_only_marked_memes_use_sticker_type_and_keep_original_bytes(self):
        response = {'messages': [
            {'type': 'text', 'text': '结论'},
            {'type': 'image', 'base64': 'dragon', 'sub_type': 1},
            {'type': 'image', 'base64': 'share-card'},
        ]}
        chains = Bridge._reply_chains_from_backend(response)
        self.assertEqual(len(chains), 3)
        self.assertEqual(chains[1][0].toDict(), {
            'type': 'image', 'data': {'file': 'base64://dragon', 'sub_type': 1, 'summary': '[龙图]'},
        })
        self.assertIsInstance(chains[2][0], Image)
        self.assertEqual(chains[2][0].args, ('share-card',))

if __name__ == '__main__': unittest.main()
