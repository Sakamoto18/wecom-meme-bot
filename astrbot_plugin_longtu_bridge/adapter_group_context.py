"""Adapter-backed history lookup; selection limits are shared with legacy."""
from .group_context import *


async def fetch_recent_group_context(event, image_loader, *, text="", pure_mention=False, include_images=True, transport=None):
    if transport is None or not transport.available or not transport.capabilities.history:
        return {}
    group_id = str(event.get_group_id())
    # Capture time before the lookup, so later messages cannot silently change
    # the question while an earlier @ is being processed.
    now = time.time()
    raw_event = getattr(event.message_obj, "raw_message", None)
    if isinstance(raw_event, dict) and isinstance(raw_event.get("time"), (int, float)):
        now = min(now, raw_event["time"])
    raw = await asyncio.wait_for(transport.history(group_id, str(event.message_obj.message_id), MAX_MESSAGES), timeout=3)
    body = raw.get("data", raw) if isinstance(raw, dict) else None
    if (not isinstance(body, dict) or not isinstance(body.get("messages"), list)
            or raw.get("status") == "failed" or raw.get("retcode", 0) not in (0, None)):
        raise RuntimeError("Group history API unavailable")
    rows = select_recent_messages(
        raw, group_id=group_id, bot_id=str(event.get_self_id()),
        message_id=str(event.message_obj.message_id), now=now,
    )
    images = []
    if include_images and wants_recent_images(text, pure_mention):
        # Only the most recent image message, close to the @. A fresh topic
        # many messages later must not inherit an unrelated old picture.
        source = next((row for row in reversed(rows[-6:])
                       if row["_images"] and now - row["time"] <= 120), None)
        if source:
            async def read(data):
                try:
                    return await asyncio.wait_for(image_loader(event, data), timeout=4)
                except Exception:
                    return ""
            loaded = await asyncio.gather(*(read(data) for data in source["_images"][:2]))
            total = 0
            for encoded in loaded:
                if not isinstance(encoded, str) or not encoded or total + len(encoded) > MAX_IMAGE_CHARACTERS:
                    continue
                total += len(encoded)
                images.append({"message_id": source["message_id"], "base64": encoded})
    return {
        "group_id": group_id,
        "messages": [{key: value for key, value in row.items() if key != "_images"} for row in rows],
        "images": images,
    }
