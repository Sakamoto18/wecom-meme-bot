"""Bounded, read-only OneBot history lookup for an unquoted group mention."""
import asyncio
import re
import time

MAX_MESSAGES = 30
MAX_CHARACTERS = 6000
MAX_AGE_SECONDS = 600
MAX_IMAGE_CHARACTERS = 8 * 1024 * 1024


def wants_recent_images(text: str, pure_mention: bool = False) -> bool:
    if pure_mention:
        return True
    return bool(re.search(
        r"刚才|刚刚|上面|前面|这张|那张|图片|截图|照片|看图|图里|"
        r"怎么看|你说呢|你觉得呢|什么意思|啥意思|什么梗|怎么回事|"
        r"^(?:你)?(?:评价|锐评|解释|分析|看看|说说)(?:一下|下|这个|这|呢|吧|呗|？|\?)?$",
        str(text or "").strip(),
    ))


def select_recent_messages(raw, *, group_id, bot_id, message_id, now):
    """Keep only preceding human messages in this group, in chronological order."""
    if isinstance(raw, dict) and isinstance(raw.get("data"), dict):
        raw = raw["data"]
    rows = raw.get("messages", []) if isinstance(raw, dict) else []
    if not isinstance(rows, list):
        return []
    rows = [row for row in rows if isinstance(row, dict)]
    def timestamp(row):
        try:
            return float(row.get("time") or 0)
        except (TypeError, ValueError):
            return 0
    rows.sort(key=timestamp)
    current = next((i for i, row in enumerate(rows)
                    if str(row.get("message_id", "")) == message_id), None)
    if current is not None:
        rows = rows[:current]
    selected = []
    for row in rows[-MAX_MESSAGES:]:
        sent_at = timestamp(row)
        sender = row.get("sender") if isinstance(row.get("sender"), dict) else {}
        user_id = str(row.get("user_id") or sender.get("user_id") or "")
        source_id = str(row.get("message_id") or "")
        if (str(row.get("group_id") or group_id) != group_id
                or not user_id or user_id == bot_id or not source_id
                or source_id == message_id or not 0 <= now - sent_at <= MAX_AGE_SECONDS):
            continue
        segments = row.get("message")
        parts, images = [], []
        if isinstance(segments, str):
            parts.append(segments)
        for segment in segments if isinstance(segments, list) else []:
            if not isinstance(segment, dict):
                continue
            data = segment.get("data") if isinstance(segment.get("data"), dict) else {}
            kind = segment.get("type")
            if kind == "text":
                parts.append(str(data.get("text") or ""))
            elif kind == "image":
                parts.append("[图片]")
                images.append(dict(data))
            elif kind == "at":
                parts.append(f"[@{data.get('qq', '')}]")
            elif kind in {"forward", "json", "xml", "video", "record"}:
                parts.append(f"[{kind}]")
        text = "".join(parts).strip()[:800]
        if not text or text.startswith("/"):
            continue
        selected.append({
            "message_id": source_id, "user_id": user_id,
            "sender_name": re.sub(r"[\r\n]+", " ", str(sender.get("card") or sender.get("nickname") or user_id))[:40],
            "text": text, "time": sent_at, "_images": images,
        })
    while sum(len(row["text"]) for row in selected) > MAX_CHARACTERS:
        selected.pop(0)
    return selected


async def fetch_recent_group_context(event, image_loader, *, text="", pure_mention=False, include_images=True):
    call_action = getattr(getattr(event, "bot", None), "call_action", None)
    if not callable(call_action):
        return {}
    group_id = str(event.get_group_id())
    # Capture time before the lookup, so later messages cannot silently change
    # the question while an earlier @ is being processed.
    now = time.time()
    raw_event = getattr(event.message_obj, "raw_message", None)
    if isinstance(raw_event, dict) and isinstance(raw_event.get("time"), (int, float)):
        now = min(now, raw_event["time"])
    raw = await asyncio.wait_for(call_action(
        "get_group_msg_history", group_id=int(group_id),
        message_seq=str(event.message_obj.message_id), count=MAX_MESSAGES,
        reverseOrder=False,
    ), timeout=3)
    body = raw.get("data", raw) if isinstance(raw, dict) else None
    if (not isinstance(body, dict) or not isinstance(body.get("messages"), list)
            or raw.get("status") == "failed" or raw.get("retcode", 0) not in (0, None)):
        raise RuntimeError("Group history API unavailable")
    rows = select_recent_messages(
        raw, group_id=group_id, bot_id=str(event.get_self_id()),
        message_id=str(event.message_obj.message_id), now=now,
    )
    images = []
    total = 0
    if include_images and wants_recent_images(text, pure_mention):
        # Download the asker's latest source first; another member's source is
        # only a candidate, selected for relevance by the backend.
        for source in image_context_sources(rows, str(event.get_sender_id()), now):
            async def read(data):
                try:
                    return await asyncio.wait_for(image_loader(event, data), timeout=4)
                except Exception:
                    return ""
            loaded = await asyncio.gather(*(read(data) for data in source["_images"][:2]))
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


def image_context_sources(rows, speaker_id, now):
    """Preserve the asker's latest upload before considering an interjection."""
    fresh = [row for row in reversed(rows) if row.get('_images') and 0 <= now - row['time'] <= 120]
    own = next((row for row in fresh if row['user_id'] == speaker_id), None)
    recent_ids = {row['message_id'] for row in rows[-6:]}
    other = next((row for row in fresh if row['user_id'] != speaker_id and row['message_id'] in recent_ids), None)
    return [row for row in (own, other) if row is not None]
