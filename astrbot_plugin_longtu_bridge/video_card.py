"""Render platform metadata without mixing in the QQ sharer's identity."""
import io
import re
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

ASSETS = Path(__file__).resolve().parent / "assets"
LOGOS = {"bilibili": "bilibili.png", "xiaohongshu": "xiaohongshu.png"}


@lru_cache(maxsize=4)
def card_font(size):
    for path in (ASSETS / "HiraginoSansGB.ttc",
                 Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")):
        try:
            return ImageFont.truetype(str(path), size)
        except OSError:
            continue
    raise RuntimeError("卡片中文字体缺失")


@lru_cache(maxsize=1)
def emoji_font():
    return ImageFont.truetype(str(ASSETS / "NotoColorEmoji.ttf"), 109)


def draw_author(card, author, font):
    # Group variation selectors, skin tones and ZWJ sequences with their emoji.
    chunks = []
    for char in author:
        cp = ord(char)
        if chunks and (cp in (0xFE0F, 0xFE0E, 0x200D, 0x20E3)
                       or 0x1F3FB <= cp <= 0x1F3FF or chunks[-1].endswith("\u200d")):
            chunks[-1] += char
        else:
            chunks.append(char)
    x = 78
    draw = ImageDraw.Draw(card)
    for chunk in chunks:
        is_emoji = any(0x1F000 <= ord(c) <= 0x1FAFF or 0x2600 <= ord(c) <= 0x27BF
                       or ord(c) in (0xFE0F, 0x20E3) for c in chunk)
        advance = 24 if is_emoji else font.getlength(chunk)
        if x + advance > 568:
            draw.text((x, 26), "…", font=font, fill="#333333")
            break
        if is_emoji:
            tile = Image.new("RGBA", (180, 160))
            ImageDraw.Draw(tile).text((0, 0), chunk, font=emoji_font(), embedded_color=True)
            bounds = tile.getbbox()
            if bounds:
                tile = tile.crop(bounds)
                tile.thumbnail((24, 24), Image.Resampling.LANCZOS)
                card.paste(tile, (round(x), 29), tile)
        else:
            draw.text((x, 26), chunk, font=font, fill="#333333")
        x += advance


def wrap_text(text, font, width):
    lines = []
    for paragraph in str(text).split("\n"):
        current = ""
        for char in paragraph:
            if current and font.getlength(current + char) > width:
                lines.append(current.rstrip())
                current = ""
            current += char
        lines.append(current.rstrip())
    return lines


def card_footer(message):
    description = str(message.get("description") or "").strip()
    if message.get("provider") == "bilibili":
        return description
    tags = message.get("tags")
    if not isinstance(tags, list):
        tags = []
    topics = []
    for tag in tags:
        if isinstance(tag, dict):
            tag = tag.get("name") or tag.get("tag_name") or ""
        if isinstance(tag, str):
            tag = tag.replace("[话题]", "").strip().strip("#").strip()
            if tag and tag not in topics:
                topics.append(tag)
    description = description.replace("[话题]", "")
    missing = ["#" + tag for tag in topics if "#" + tag not in description]
    return "\n".join(part for part in (description, "  ".join(missing)) if part)



def render_video_card(message, cover_bytes=b"", avatar_bytes=b""):
    width, padding = 760, 24
    font, small = card_font(30), card_font(22)
    title = str(message.get("title") or "").strip()
    if re.fullmatch(r"[a-fA-F0-9]{24,}(?:[_-]\w+)*", title):
        title = ""
    title_lines = wrap_text(title, font, width - padding * 2) if title else []
    title_y, title_step = 82, 40
    cover_y = title_y + len(title_lines) * title_step + 20
    cover = None
    if cover_bytes:
        cover = Image.open(io.BytesIO(cover_bytes)).convert("RGB")
        portrait = cover.height > cover.width
        target = (430, 760) if portrait else (712, 400)
        scale = min(target[0] / cover.width, target[1] / cover.height)
        cover = cover.resize((round(cover.width * scale), round(cover.height * scale)), Image.Resampling.LANCZOS)
    cover_height = cover.height if cover else 0
    footer = card_footer(message)
    footer_lines = wrap_text(footer, small, width - padding * 2) if footer else []
    footer_y = cover_y + cover_height + 24
    # Fixed height previously clipped all footer text under portrait covers.
    height = footer_y + len(footer_lines) * 32 + padding
    card = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(card)
    author = str(message.get("author") or "").strip()
    if avatar_bytes:
        avatar = Image.open(io.BytesIO(avatar_bytes)).convert("RGB")
        avatar = ImageOps.fit(avatar, (44, 44), method=Image.Resampling.LANCZOS)
        # Supersample the circular mask for a smooth edge at the displayed size.
        mask = Image.new("L", (176, 176), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, 175, 175), fill=255)
        mask = mask.resize(avatar.size, Image.Resampling.LANCZOS)
        card.paste(avatar, (padding, 20), mask)
    if author:
        draw_author(card, author, small)
    if message.get("provider") == "bilibili" and message.get("publishedAt"):
        try:
            published = datetime.fromtimestamp(float(message["publishedAt"]), timezone(timedelta(hours=8)))
            draw.text((78, 55), published.strftime("%Y-%m-%d %H:%M"),
                      font=card_font(16), fill="#888888")
        except (ValueError, TypeError, OverflowError, OSError):
            pass
    logo_file = LOGOS.get(str(message.get("provider") or ""))
    if logo_file:
        # Official website assets downloaded once, with provenance.
        with Image.open(ASSETS / "logos" / logo_file) as original:
            logo = original.convert("RGBA")
        logo.thumbnail((112, 52), Image.Resampling.LANCZOS)
        card.paste(logo, (width - padding - logo.width, 20 + (44 - logo.height) // 2), logo)
    for i, line in enumerate(title_lines):
        draw.text((padding, title_y + i * title_step), line, fill="#44208f", font=font)
    if cover:
        card.paste(cover, (padding if portrait else (width - cover.width) // 2, cover_y))
    color = "#666666" if message.get("provider") == "bilibili" else "#333333"
    for i, line in enumerate(footer_lines):
        draw.text((padding, footer_y + i * 32), line, fill=color, font=small)
    output = io.BytesIO()
    card.save(output, format="PNG", optimize=True)
    return output.getvalue()
