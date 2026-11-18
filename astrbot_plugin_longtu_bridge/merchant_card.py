"""Render fresh merchant stock in a game-inspired shop panel, using actual icons."""
import io
import math
from datetime import datetime
from functools import lru_cache
from PIL import Image, ImageDraw, ImageFont, ImageOps
from .video_card import card_font
from .merchant_alert import BJ


def wrap(draw, value, font, width):
    lines, line = [], ''
    for c in str(value):
        if c == '\n' or (line and draw.textlength(line + c, font=font) > width):
            lines.append(line)
            line = '' if c == '\n' else c
        else:
            line += c
    if line:
        lines.append(line)
    return lines


@lru_cache(maxsize=4)
def shop_title_font(size):
    regular = card_font(size)
    if regular.getname()[0] == 'Hiragino Sans GB':
        # Use the bundled W6 face: synthetic outlines fill dense Chinese glyphs.
        try:
            return ImageFont.truetype(regular.path, size, index=2)
        except OSError:
            pass
    return regular


def compass(draw, cx, cy, radius, color):
    """Original compass ornament; not an official game logo."""
    draw.ellipse((cx-radius, cy-radius, cx+radius, cy+radius), outline=color, width=2)
    points = []
    for step in range(16):
        angle = step * math.pi / 8 - math.pi / 2
        r = radius * (1.15 if step % 4 == 0 else .72 if step % 2 == 0 else .26)
        points.append((cx + math.cos(angle) * r, cy + math.sin(angle) * r))
    draw.polygon(points, fill=color)
    draw.ellipse((cx-5, cy-5, cx+5, cy+5), fill='#292b32')


def render_merchant_card(snapshot, selected, icons, now):
    items = snapshot['items']
    if not items or now >= snapshot['end']:
        raise ValueError('Cannot render expired merchant stock')
    width, margin = 1080, 44
    ink, muted = '#302b24', '#68502e'
    dummy = ImageDraw.Draw(Image.new('RGB', (1, 1)))
    rows = []
    for index, item in enumerate(items):
        title = wrap(dummy, item['name'], shop_title_font(32), 680)
        price = wrap(dummy, f'{item["price"]} {item.get("currency", "洛克贝")}    限购 {item["limit"]}', card_font(26), 680)
        details = wrap(dummy, item.get('description', ''), card_font(23), 680)
        row_height = max(166, 88 + len(title) * 40 + len(details) * 31 + (len(price) - 1) * 34)
        rows.append((index, item, title, price, details, row_height))
    height = 266 + sum(row[5] + 16 for row in rows) + 122
    if height > 12000:
        raise ValueError('Merchant card too large')
    card = Image.new('RGB', (width, height))
    draw = ImageDraw.Draw(card)
    # Sky blue backing with broad, quiet facets, leaving the stock itself prominent.
    top, bottom = (89, 130, 190), (173, 199, 222)
    for y in range(height):
        blend = min(1, y / max(height - 1, 1))
        color = tuple(round(a + (b - a) * blend) for a, b in zip(top, bottom))
        draw.line((0, y, width, y), fill=color)
    draw.polygon([(0, 0), (405, 0), (0, 660)], fill='#648ac0')
    draw.polygon([(width, height), (width-340, height), (width, height-600)], fill='#a2bed9')
    draw.rounded_rectangle((margin, 39, width-margin, 229), radius=30, fill='#4c6c96')
    draw.rounded_rectangle((margin, 32, width-margin, 222), radius=30, fill='#292b32', outline='#e5be61', width=2)
    draw.polygon([(570, 35), (780, 35), (680, 219), (470, 219)], fill='#30323a')
    compass(draw, 100, 85, 28, '#f4cd70')
    draw.text((150, 45), '商店', font=card_font(24), fill='#f4cd70')
    draw.text((148, 77), '远行商人', font=shop_title_font(42), fill='#fff7df')
    draw.rounded_rectangle((825, 57, 1008, 102), radius=12, fill='#f3cd74')
    draw.text((846, 63), '本轮在售', font=card_font(27), fill=ink)
    start = datetime.fromtimestamp(snapshot['start'], BJ)
    end = datetime.fromtimestamp(snapshot['end'], BJ)
    remaining = max(0, int(snapshot['end'] - now))
    draw.text((margin + 28, 133), f'{start:%m月%d日} 第{snapshot["round"]}轮  {start:%H:%M}—{end:%H:%M}（北京时间）', font=card_font(26), fill='#e5e1d6')
    draw.text((margin + 28, 173), f'距刷新 {remaining // 3600:02d}:{remaining // 60 % 60:02d}:{remaining % 60:02d}', font=card_font(30), fill='#ffdc83')
    y = 246
    for index, item, titles, prices, details, row_height in rows:
        target = index in selected
        draw.rounded_rectangle((margin, y+5, width-margin, y+row_height+5), radius=22, fill='#7892ac')
        draw.rounded_rectangle((margin, y, width-margin, y+row_height), radius=22,
                               fill='#f7d16f' if target else '#f5dfaa',
                               outline='#ffe9a0' if target else '#ffedc1', width=3)
        # A translucent-looking gold facet and medallion frame echo the shop UI.
        draw.polygon([(margin+22, y+5), (margin+157, y+5), (margin+129, y+row_height-5),
                      (margin+6, y+row_height-22)], fill='#eabe60' if target else '#eacf96')
        cx, cy = margin+86, y+82
        draw.ellipse((cx-67, cy-67, cx+67, cy+67), fill='#ffe4a1' if target else '#f9e9bd',
                     outline='#d8aa4b' if target else '#d5b577', width=2)
        data = icons.get(item['image'])
        if not data:
            raise ValueError('Missing current product icon')
        with Image.open(io.BytesIO(data)) as original:
            if original.width * original.height > 16_000_000:
                raise ValueError('Product image too large')
            icon = ImageOps.contain(original.convert('RGBA'), (124, 124))
        card.paste(icon, (cx-icon.width//2, cy-icon.height//2), icon)
        if target:
            draw.rounded_rectangle((margin+20, y+132, margin+152, y+162), radius=7, fill='#42362b')
            draw.text((margin+36, y+133), '订阅命中', font=card_font(21), fill='#ffe09a')
        x, ty = margin+178, y+20
        for title in titles:
            draw.text((x, ty), title, font=shop_title_font(32), fill=ink)
            ty += 40
        for price in prices:
            draw.text((x, ty+4), price, font=card_font(26), fill='#76501c')
            ty += 34
        ty += 14
        for line in details:
            draw.text((x, ty), line, font=card_font(23), fill=muted)
            ty += 31
        y += row_height+16
    captured = datetime.fromtimestamp(snapshot['fetchedAt'], BJ)
    generated = datetime.fromtimestamp(now, BJ)
    draw.rounded_rectangle((margin, y, width-margin, y+108), radius=16, fill='#dce7ed')
    draw.text((margin+18, y+8), f'采集 {captured:%H:%M:%S} · 制图 {generated:%H:%M:%S} · 倒计时以制图时刻为准', font=card_font(22), fill='#40546b')
    draw.text((margin+18, y+44), '库存与商品原图：好游快爆远行商人查询器 · 实时数据整理图', font=card_font(22), fill='#40546b')
    if snapshot['source'].startswith('https://lk.y1g.cc/'):
        draw.text((margin+18, y+76), '数据转引：lk.y1g.cc（当轮缓存）', font=card_font(20), fill='#40546b')
    out = io.BytesIO()
    card.save(out, format='PNG', optimize=True)
    return out.getvalue()
