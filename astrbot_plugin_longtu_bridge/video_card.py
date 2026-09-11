"""Render platform metadata without mixing in the QQ sharer's identity."""
import io
import re
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
    if not topics:
        topics = list(dict.fromkeys(re.findall(
            r"#([^\s#，。！？]+)", description.replace("[话题]", ""),
        )))
    return "  ".join("#" + tag for tag in topics)


def render_video_card(message, cover_bytes=b"", avatar_bytes=b""):
    width, padding = 760, 24
    font, small = card_font(30), card_font(22)
    title = str(message.get("title") or "视频分享").strip()
    title_lines = wrap_text(title, font, width - padding * 2)
    title_y, title_step = 82, 40
    cover_y = title_y + len(title_lines) * title_step + 20
    cover = None
    if cover_bytes:
        cover = Image.open(io.BytesIO(cover_bytes)).convert("RGB")
        cover.thumbnail((720, 390), Image.Resampling.LANCZOS)
    cover_height = cover.height if cover else 0
    footer = card_footer(message)
    footer_lines = wrap_text(footer, small, width - padding * 2) if footer else []
    if footer and message.get("provider") != "bilibili":
        # Keep a topic together where possible, rather than leaving a lone #
        # at the end of one line and its text on the next.
        footer_lines, current = [], ""
        for topic in footer.split("  "):
            candidate = (current + "  " + topic) if current else topic
            if current and small.getlength(candidate) > width - padding * 2:
                footer_lines.extend(wrap_text(current, small, width - padding * 2))
                current = topic
            else:
                current = candidate
        footer_lines.extend(wrap_text(current, small, width - padding * 2))
    footer_y = cover_y + cover_height + 24
    # Fixed height previously clipped all footer text under portrait covers.
    height = footer_y + len(footer_lines) * 32 + padding
    card = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(card)
    author = str(message.get("author") or "").strip()
    if avatar_bytes:
        avatar = Image.open(io.BytesIO(avatar_bytes)).convert("RGB")
        avatar = ImageOps.fit(avatar, (44, 44), method=Image.Resampling.LANCZOS)
        card.paste(avatar, (padding, 20))
    while author and small.getlength(author) > 490:
        author = author[:-2] + "…"
    if author:
        draw.text((78, 26), author, fill="#333333", font=small)
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
        card.paste(cover, ((width - cover.width) // 2, cover_y))
    color = "#666666" if message.get("provider") == "bilibili" else "#c05a78"
    for i, line in enumerate(footer_lines):
        draw.text((padding, footer_y + i * 32), line, fill=color, font=small)
    output = io.BytesIO()
    card.save(output, format="PNG", optimize=True)
    return output.getvalue()
