"""Render current source goods and their actual icons; never reuse prior cards."""
import io
from datetime import datetime
from PIL import Image, ImageDraw, ImageOps
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


def render_merchant_card(snapshot, selected, icons, now):
    items = snapshot['items']
    if not items or now >= snapshot['end']:
        raise ValueError('Cannot render expired merchant stock')
    width, margin = 1080, 44
    ink, muted, gold = '#243931', '#6c7d75', '#b17b26'
    dummy = ImageDraw.Draw(Image.new('RGB', (1, 1)))
    rows = []
    for index, item in enumerate(items):
        title = wrap(dummy, item['name'], card_font(32), 680)
        details = wrap(dummy, item.get('description', ''), card_font(23), 680)
        rows.append((index, item, title, details, max(166, 88 + len(title) * 40 + len(details) * 31)))
    height = 266 + sum(row[4] + 16 for row in rows) + 122
    if height > 12000:
        raise ValueError('Merchant card too large')
    card = Image.new('RGB', (width, height), '#f4f7f0')
    draw = ImageDraw.Draw(card)
    draw.rounded_rectangle((margin, 32, width - margin, 222), radius=22, fill='#244b3e')
    draw.text((margin + 26, 50), '远行商人 · 本轮在售', font=card_font(42), fill='white')
    start = datetime.fromtimestamp(snapshot['start'], BJ)
    end = datetime.fromtimestamp(snapshot['end'], BJ)
    remaining = max(0, int(snapshot['end'] - now))
    draw.text((margin + 28, 110), f'{start:%m月%d日} 第{snapshot["round"]}轮  {start:%H:%M}—{end:%H:%M}（北京时间）', font=card_font(26), fill='#dbe8dd')
    draw.text((margin + 28, 160), f'距刷新 {remaining // 3600:02d}:{remaining // 60 % 60:02d}:{remaining % 60:02d}', font=card_font(32), fill='#ffdf99')
    y = 246
    for index, item, titles, details, row_height in rows:
        target = index in selected
        draw.rounded_rectangle((margin, y, width - margin, y + row_height), radius=18,
                               fill='#fff7df' if target else 'white', outline='#d4b36c' if target else '#e0e7df', width=2)
        data = icons.get(item['image'])
        if not data:
            raise ValueError('Missing current product icon')
        with Image.open(io.BytesIO(data)) as original:
            if original.width * original.height > 16_000_000:
                raise ValueError('Product image too large')
            icon = ImageOps.contain(original.convert('RGBA'), (124, 124))
        card.paste(icon, (margin + 24 + (124 - icon.width) // 2, y + 22 + (124 - icon.height) // 2), icon)
        if target:
            draw.text((margin + 24, y + 150), '订阅命中', font=card_font(21), fill=gold)
        x, ty = margin + 178, y + 20
        for title in titles:
            draw.text((x, ty), title, font=card_font(32), fill=ink)
            ty += 40
        draw.text((x, ty + 4), f'{item["price"]} {item.get("currency", "洛克贝")}    限购 {item["limit"]}', font=card_font(26), fill=gold)
        ty += 48
        for line in details:
            draw.text((x, ty), line, font=card_font(23), fill=muted)
            ty += 31
        y += row_height + 16
    captured = datetime.fromtimestamp(snapshot['fetchedAt'], BJ)
    generated = datetime.fromtimestamp(now, BJ)
    draw.text((margin, y + 8), f'采集 {captured:%H:%M:%S} · 制图 {generated:%H:%M:%S} · 倒计时以制图时刻为准', font=card_font(22), fill=muted)
    draw.text((margin, y + 44), '库存与商品原图：好游快爆远行商人查询器 · 实时数据整理图', font=card_font(22), fill=muted)
    if snapshot['source'].startswith('https://lk.y1g.cc/'):
        draw.text((margin, y + 76), '数据转引：lk.y1g.cc（当轮缓存）', font=card_font(20), fill=muted)
    out = io.BytesIO()
    card.save(out, format='PNG', optimize=True)
    return out.getvalue()
