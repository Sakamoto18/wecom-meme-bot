"""Render platform metadata without mixing in the QQ sharer's identity."""
import io
import re
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

ASSETS = Path(__file__).resolve().parent / "assets"
LOGOS = {"bilibili": "bilibili.png", "xiaohongshu": "xiaohongshu.png", "douyin": "douyin.png"}

# QQ and several mobile clients encode their built-in emoji in the Unicode
# private-use area.  The bundled Noto Color Emoji font contains the relevant
# glyphs, but a normal CJK font does not; sending these characters through the
# CJK renderer produces the square placeholders seen in share cards.
PRIVATE_USE_EMOJI_RANGES = (
    (0xFE4E5, 0xFE4EE),
    (0xFE82C, 0xFE82C),
    (0xFE82E, 0xFE837),
)


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


def text_clusters(text):
    """Keep emoji modifiers, flags and ZWJ sequences intact when wrapping."""
    chunks = []
    for char in str(text):
        cp = ord(char)
        regional = 0x1F1E6 <= cp <= 0x1F1FF
        if chunks and chunks[-1] != "\n" and (
            cp in (0xFE0F, 0xFE0E, 0x200D, 0x20E3)
            or 0x1F3FB <= cp <= 0x1F3FF or 0xE0020 <= cp <= 0xE007F
            or chunks[-1].endswith("\u200d")
            or (regional and len(chunks[-1]) == 1 and 0x1F1E6 <= ord(chunks[-1]) <= 0x1F1FF)
        ):
            chunks[-1] += char
        else:
            chunks.append(char)
    return chunks


def is_emoji(chunk):
    if "\ufe0e" in chunk or chunk.rstrip("\ufe0f") in ("▪", "▫"):
        return False
    return any(0x1F000 <= ord(c) <= 0x1FAFF or 0x2600 <= ord(c) <= 0x27BF
               or ord(c) in (0xFE0F, 0x20E3, 0x231A, 0x231B, 0x23F0, 0x23F3)
               or any(start <= ord(c) <= end for start, end in PRIVATE_USE_EMOJI_RANGES)
               for c in chunk)


@lru_cache(maxsize=256)
def emoji_tile(chunk, size):
    font = emoji_font()
    bounds = font.getbbox(chunk)
    tile = Image.new("RGBA", (max(1, bounds[2] - bounds[0]), max(1, bounds[3] - bounds[1])))
    ImageDraw.Draw(tile).text((-bounds[0], -bounds[1]), chunk, font=font, embedded_color=True)
    painted = tile.getbbox()
    if not painted:
        return None
    # Scale the complete font cell, not its ink bounds. Cropping ink first
    # enlarges tiny symbols into full-size blocks and distorts emoji proportions.
    tile.thumbnail((size, size), Image.Resampling.LANCZOS)
    return tile


def text_width(text, font):
    return sum(font.size * 0.55 if c.rstrip("\ufe0f") in ("▪", "▫") else
               font.size if is_emoji(c) else font.getlength(c.rstrip("\ufe0f")) for c in text_clusters(text))


def draw_rich_text(card, xy, text, font, fill, max_width=None):
    x, y = xy
    draw = ImageDraw.Draw(card)
    for chunk in text_clusters(text):
        size = font.size
        advance = text_width(chunk, font)
        if max_width is not None and x + advance > xy[0] + max_width:
            break
        if chunk.rstrip("\ufe0f") in ("▪", "▫"):
            # These geometric bullets are absent in some CJK fonts. Their
            # small square shape is independent of platform emoji artwork.
            edge = max(3, round(size * 0.25))
            left, top = round(x + 2), round(y + size * 0.6)
            draw.rectangle((left, top, left + edge - 1, top + edge - 1),
                           fill=fill if chunk.startswith("▪") else None, outline=fill)
        elif is_emoji(chunk):
            tile = emoji_tile(chunk, size)
            if tile:
                card.paste(tile, (round(x + (size - tile.width) / 2), round(y + (size - tile.height) / 2 + 3)), tile)
            else:
                draw.text((x, y), chunk, font=font, fill=fill)
        else:
            draw.text((x, y), chunk.rstrip("\ufe0f"), font=font, fill=fill)
        x += advance


def draw_author(card, author, font):
    if text_width(author, font) > 490:
        chunks = text_clusters(author)
        while chunks and text_width("".join(chunks) + "…", font) > 490:
            chunks.pop()
        author = "".join(chunks) + "…"
    draw_rich_text(card, (78, 26), author, font, "#333333")


def wrap_text(text, font, width):
    lines = []
    for paragraph in str(text).split("\n"):
        current, current_width = "", 0
        for chunk in text_clusters(paragraph):
            advance = text_width(chunk, font)
            if current and current_width + advance > width:
                lines.append(current.rstrip())
                current, current_width = "", 0
            current += chunk
            current_width += advance
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



def gallery_grid(previews, total, width=712):
    count = min(total, 9)
    columns = min(count, 3)
    gap = 5
    cell = (width - gap * (columns - 1)) // columns
    rows = (count + columns - 1) // columns
    grid = Image.new("RGB", (width, rows * cell + (rows - 1) * gap), "white")
    for index in range(count):
        tile = Image.new("RGB", (cell, cell), "#eeeeee")
        raw = previews[index] if index < len(previews) else b""
        if raw:
            try:
                with Image.open(io.BytesIO(raw)) as source:
                    tile = ImageOps.fit(ImageOps.exif_transpose(source).convert("RGB"),
                                        (cell, cell), method=Image.Resampling.LANCZOS)
            except (OSError, ValueError):
                pass
        if index == 8 and total > 9:
            tile = Image.blend(tile, Image.new("RGB", tile.size, "black"), 0.48)
            ImageDraw.Draw(tile).text((cell / 2, cell / 2), f"+{total - 9}",
                                     font=card_font(48), fill="white", anchor="mm")
        grid.paste(tile, ((index % columns) * (cell + gap), (index // columns) * (cell + gap)))
    return grid


def render_video_card(message, cover_bytes=b"", avatar_bytes=b"", preview_bytes=None):
    width, padding = 760, 24
    font, small = card_font(30), card_font(22)
    title = str(message.get("title") or "").strip()
    if re.fullmatch(r"[a-fA-F0-9]{24,}(?:[_-]\w+)*", title):
        title = ""
    title_lines = wrap_text(title, font, width - padding * 2) if title else []
    title_y, title_step = 82, 40
    cover_y = title_y + len(title_lines) * title_step + 20
    cover = None
    portrait = False
    if preview_bytes is not None and len(message.get("images") or []) > 1:
        cover = gallery_grid(preview_bytes, len(message["images"]))
    elif cover_bytes:
        # 状态码正常但内容不是图片（CDN 的 200 错误页、截断的响应）时，只
        # 放弃封面，卡片其余部分照常渲染。gallery_grid 同理。
        try:
            cover = Image.open(io.BytesIO(cover_bytes)).convert("RGB")
        except (OSError, ValueError):
            cover = None
        if cover:
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
        try:
            avatar = Image.open(io.BytesIO(avatar_bytes)).convert("RGB")
        except (OSError, ValueError):
            avatar = None
        if avatar:
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
        draw_rich_text(card, (padding, title_y + i * title_step), line, font, "#44208f")
    if cover:
        card.paste(cover, (padding if portrait else (width - cover.width) // 2, cover_y))
    color = "#666666" if message.get("provider") == "bilibili" else "#333333"
    for i, line in enumerate(footer_lines):
        draw_rich_text(card, (padding, footer_y + i * 32), line, small, color)
    output = io.BytesIO()
    card.save(output, format="PNG", optimize=True)
    return output.getvalue()
