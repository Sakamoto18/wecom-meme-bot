"""Run inside the deployed AstrBot image; no real QQ calls are made.

Usage: python verify_astrbot_sticker_pipeline.py /path/to/bridge
Exercises the real RespondStage and OneBot serializer around bridge delivery.
"""
import ast
import asyncio
import importlib.util
import inspect
import json
import logging
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import astrbot.api.message_components as Comp
from astrbot.core.message.message_event_result import MessageEventResult
from astrbot.core.pipeline.respond.stage import RespondStage
from astrbot.core.platform.sources.aiocqhttp.aiocqhttp_message_event import AiocqhttpMessageEvent

root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('tested_qq_sticker', root / 'qq_sticker.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
QqSticker = module.QqSticker
parsed = ast.parse((root / 'main.py').read_text())
bridge = next(n for n in parsed.body if isinstance(n, ast.ClassDef) and n.name == 'LongtuQqBridge')
methods = [n for n in bridge.body if getattr(n, 'name', '') in ('_reply_chains_from_backend', '_deliver_reply_chains')]
namespace = {'Comp': Comp, 'QqSticker': QqSticker, 'asyncio': asyncio, 'logger': logging.getLogger('pipeline-test')}
exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='Bridge', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])), '<real-bridge-methods>', 'exec'), namespace)
Bridge = namespace['Bridge']
PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8hkAAAAASUVORK5CYII='

class RecordingBot:
    def __init__(self): self.calls = []
    async def call_action(self, action, **kwargs):
        self.calls.append((action, kwargs))
        return {'message_id': len(self.calls)}
    async def send_group_msg(self, **kwargs): return await self.call_action('send_group_msg', **kwargs)
    async def send_private_msg(self, **kwargs): return await self.call_action('send_private_msg', **kwargs)

class Event:
    def __init__(self, private): self.private, self.bot, self.result = private, RecordingBot(), None
    def is_private_chat(self): return self.private
    def get_group_id(self): return '1109147947'
    def get_sender_id(self): return '1079175957'
    def get_sender_name(self): return '隔离测试'
    def get_platform_name(self): return 'aiocqhttp'
    def get_extra(self, key, default=None): return default
    def get_result(self): return self.result
    def clear_result(self): self.result = None
    def _outline_chain(self, chain): return ','.join(type(c).__name__ for c in chain)
    def chain_result(self, chain): return MessageEventResult(chain=chain)
    async def send(self, result):
        await AiocqhttpMessageEvent.send_message(self.bot, result, is_group=not self.private,
            session_id=self.get_sender_id() if self.private else self.get_group_id())

async def process(stage, event):
    result = stage.process(event)
    if inspect.isasyncgen(result):
        async for _ in result: pass
    else: await result

async def main():
    for private in (False, True):
        for segmented in (False, True):
            stage = RespondStage()
            await stage.initialize(SimpleNamespace(astrbot_config={'platform_settings': {
                'reply_with_mention': False, 'reply_with_quote': False,
                'segmented_reply': {'enable': segmented, 'only_llm_result': False,
                    'interval_method': 'random', 'log_base': 2, 'interval': '0,0'},
            }}))
            event = Event(private)
            # Reproduce the exact previous omission, rather than only checking
            # that the final OneBot serializer happens to accept custom types.
            assert await stage._is_empty_message_chain([QqSticker(file='base64://' + PNG)])
            response = {'messages': [
                {'type': 'text', 'text': '第一条'}, {'type': 'text', 'text': '第二条'},
                {'type': 'image', 'base64': PNG, 'sub_type': 1},
                {'type': 'image', 'base64': PNG},
            ]}
            async for result in Bridge()._deliver_reply_chains(event, Bridge._reply_chains_from_backend(response), []):
                assert not any(isinstance(c, QqSticker) for c in result.chain)
                event.result = result
                await process(stage, event)
            assert len(event.bot.calls) == 4, event.bot.calls
            segments = [kwargs['message'][0] for _, kwargs in event.bot.calls]
            assert [s['type'] for s in segments] == ['text', 'text', 'image', 'image']
            assert segments[2]['data']['sub_type'] == 1
            assert 'sub_type' not in segments[3]['data']
            assert all(action == ('send_private_msg' if private else 'send_group_msg') for action, _ in event.bot.calls)
            # Image-only commands may carry the reply/@ prefix. It must not be
            # dropped, nor used merely to trick the framework's empty validator.
            event = Event(private)
            prefix = [Comp.At(qq='1079175957'), Comp.Plain(' ')] if not private else []
            async for _ in Bridge()._deliver_reply_chains(event, [[QqSticker(file='base64://' + PNG)]], prefix):
                raise AssertionError('Sticker must not be yielded')
            assert len(event.bot.calls) == 1
            assert event.bot.calls[0][1]['message'][-1]['data']['sub_type'] == 1
            if prefix: assert event.bot.calls[0][1]['message'][0]['type'] == 'at'
            print(json.dumps({'private': private, 'segmented': segmented, 'ordered_sends': 4, 'sticker_receipt_verified': True, 'network_sends': 0}))

with patch('astrbot.core.pipeline.respond.stage.call_event_hook', new=AsyncMock(return_value=False)):
    asyncio.run(main())
