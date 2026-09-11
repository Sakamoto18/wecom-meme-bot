"""Render the deployed Bridge's actual _video_card method without sending a chat.

Run inside AstrBot with a JSON video message returned by the live Node resolver:
  python verify-video-card.py PLUGIN_DIR message.json result.png
"""
import ast
import asyncio
import base64
import importlib.util
import json
import logging
import sys
from pathlib import Path
from types import SimpleNamespace

import aiohttp


async def main():
    plugin_dir, message_file, output = map(Path, sys.argv[1:])
    spec = importlib.util.spec_from_file_location("card_renderer", plugin_dir / "video_card.py")
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    source = ast.parse((plugin_dir / "main.py").read_text())
    bridge = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == "LongtuQqBridge")
    method = next(n for n in bridge.body if getattr(n, "name", "") == "_video_card")
    namespace = {"aiohttp": aiohttp, "base64": base64, "logger": logging.getLogger("verify-card"),
                 "render_video_card": renderer.render_video_card}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), str(plugin_dir / "main.py"), "exec"), namespace)
    message = json.loads(message_file.read_text())
    async with aiohttp.ClientSession() as session:
        encoded = await namespace["_video_card"](SimpleNamespace(session=session), message)
    if not encoded:
        raise RuntimeError("Live Bridge returned no card")
    output.write_bytes(base64.b64decode(encoded))
    print(json.dumps({"provider": message.get("provider"), "title": message.get("title"),
        "author": message.get("author"), "avatar": bool(message.get("avatarUrl")),
        "description_chars": len(message.get("description") or ""),
        "tags": message.get("tags", []), "image_bytes": output.stat().st_size}, ensure_ascii=False))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
