"""Execute the actual bridge methods with a recording OneBot client."""
import ast
import logging
from pathlib import Path
from types import SimpleNamespace
import unittest

source = ast.parse((Path(__file__).resolve().parents[1] / 'astrbot_plugin_longtu_bridge/main.py').read_text())
bridge = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
methods = [n for n in bridge.body if getattr(n, 'name', '') in ('_reply_chain_from_backend', '_send_forward_from_backend')]

class Component:
    def __init__(self, *args, **kwargs): self.args, self.kwargs = args, kwargs
class Image(Component): pass
class Video(Component): pass
class Plain(Component): pass

namespace = {'AstrMessageEvent': object, 'logger': logging.getLogger('test'),
             'Comp': SimpleNamespace(Image=Image, Video=Video, Plain=Plain)}
exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='Bridge', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])), '<bridge-methods>', 'exec'), namespace)
Bridge = namespace['Bridge']

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
        self.assertEqual(len(calls), 1)
        action, kwargs = calls[0]
        self.assertEqual(action, 'send_group_forward_msg')
        nodes = kwargs['messages']
        self.assertEqual(len(nodes), 3)
        self.assertEqual([n['data']['content'][0]['type'] for n in nodes], ['text', 'image', 'image'])
        self.assertNotIn('[话题]', nodes[0]['data']['content'][0]['data']['text'])

    async def test_private_images_use_private_forward(self):
        event, calls = self.event(private=True)
        self.assertTrue(await Bridge()._send_forward_from_backend(event, self.gallery()))
        self.assertEqual(calls[0][0], 'send_private_forward_msg')
        self.assertEqual(calls[0][1]['user_id'], 1079175957)
        self.assertNotIn('group_id', calls[0][1])

    async def test_video_never_enters_forward_sender(self):
        event, calls = self.event()
        response = {'mode': 'media', 'messages': [{'type': 'video', 'url': 'https://cdn.example/720.mp4', 'title': '视频标题'}]}
        self.assertFalse(await Bridge()._send_forward_from_backend(event, response))
        self.assertEqual(calls, [])
        chain = Bridge._reply_chain_from_backend(response)
        self.assertEqual([type(item) for item in chain], [Plain, Video])
        self.assertEqual(chain[0].args, ('视频标题',))

    async def test_failed_forward_falls_back_to_images_not_links(self):
        event, calls = self.event(fail_forward=True)
        self.assertTrue(await Bridge()._send_forward_from_backend(event, self.gallery()))
        self.assertEqual([c[0] for c in calls], ['send_group_forward_msg', 'send_group_msg', 'send_group_msg'])
        self.assertEqual(calls[-1][1]['message'][0]['type'], 'image')

    def test_final_gallery_fallback_uses_native_images(self):
        chain = Bridge._reply_chain_from_backend(self.gallery())
        self.assertEqual([type(c) for c in chain], [Plain, Image, Image])

if __name__ == '__main__': unittest.main()
