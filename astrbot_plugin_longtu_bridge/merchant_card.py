"""Render fresh merchant stock in a game-inspired shop panel, using actual icons."""
import io
from datetime import datetime
from functools import lru_cache
from PIL import Image, ImageDraw, ImageFont, ImageOps
from .video_card import card_font, ASSETS
from .merchant_alert import BJ, daily_item


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


@lru_cache(maxsize=8)
def shop_font(size):
    # Match the reference page's Microsoft Yahei fallback on the Windows host.
    try:
        return ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', size)
    except OSError:
        return card_font(size)


@lru_cache(maxsize=4)
def shop_title_font(size):
    try:
        return ImageFont.truetype('C:/Windows/Fonts/msyhbd.ttc', size)
    except OSError:
        pass
    regular = card_font(size)
    if regular.getname()[0] == 'Hiragino Sans GB':
        # Use the bundled W6 face: synthetic outlines fill dense Chinese glyphs.
        try:
            return ImageFont.truetype(regular.path, size, index=2)
        except OSError:
            pass
    return regular


@lru_cache(maxsize=16)
def shop_asset(name):
    with Image.open(ASSETS / 'merchant' / name) as source:
        return source.convert('RGBA')


def paste_asset(card, name, box, crop=None):
    asset = shop_asset(name)
    if crop:
        asset = asset.crop(crop)
    x, y, width, height = box
    asset = asset.resize((width, height), Image.Resampling.LANCZOS)
    card.paste(asset, (x, y), asset)


def render_merchant_card(snapshot, selected, icons, now):
    items = snapshot['items']
    if not items or now >= snapshot['end']:
        raise ValueError('Cannot render expired merchant stock')
    width, margin = 1080, 44
    ink, muted = '#302b24', '#68502e'
    dummy = ImageDraw.Draw(Image.new('RGB', (1, 1)))
    rows = []
    for index, item in enumerate(items):
        title = wrap(dummy, item['name'], shop_title_font(32), 610)
        limit_width = max(140, int(dummy.textlength(f'限购 {item["limit"]}', font=shop_font(21)))+24)
        price_text = f'{item["price"]} {item.get("currency", "洛克贝")}'
        if limit_width > 156:
            price_text += f'    限购 {item["limit"]}'
        price = wrap(dummy, price_text, shop_font(26), 680)
        sale_note = '当天售卖 · 当日24:00结束，不随中间轮次刷新\n' if daily_item(item) else ''
        details = wrap(dummy, sale_note + item.get('description', ''), shop_font(23), 680)
        row_height = max(166, 88 + len(title) * 40 + len(details) * 31 + (len(price) - 1) * 34)
        rows.append((index, item, title, price, details, row_height))
    height = 282 + sum(row[5] + 16 for row in rows) + 62
    if height > 12000:
        raise ValueError('Merchant card too large')
    card = Image.new('RGB', (width, height), '#75412f')
    background = shop_asset('bg.jpg')
    scaled = background.resize((width, round(background.height * width / background.width)), Image.Resampling.LANCZOS)
    card.paste(scaled, (0, 0))
    draw = ImageDraw.Draw(card)
    # The title is cropped from the user's game screenshot, preserving its
    # actual lettering. Decorative panels are the reference site's own assets.
    paste_asset(card, 'game-shop-title.png', (0, 8, 426, 124), crop=(128, 0, 554, 124))
    start = datetime.fromtimestamp(snapshot['start'], BJ)
    end = datetime.fromtimestamp(snapshot['end'], BJ)
    remaining = max(0, int(snapshot['end'] - now))
    draw.rounded_rectangle((44, 140, 1036, 185), radius=12, fill='#292d2e')
    draw.text((64, 147), f'{start:%m月%d日} 第{snapshot["round"]}轮  {start:%H:%M}—{end:%H:%M}（北京时间）', font=shop_font(26), fill='#fffaee')
    draw.rounded_rectangle((668, 52, 1036, 112), radius=30, fill='#1f1f1f')
    paste_asset(card, 'icon-sl1.png', (686, 67, 27, 30))
    draw.rounded_rectangle((728, 60, 1027, 104), radius=22, fill='#fffaee')
    draw.text((748, 66), f'本轮剩余 {remaining // 3600:02d}:{remaining // 60 % 60:02d}:{remaining % 60:02d}', font=shop_font(26), fill='#1f1f1f')
    paste_asset(card, 'bx1.png', (32, 190, 1016, 154), crop=(0, 0, 725, 110))
    paste_asset(card, 'tit1.png', (105, 203, 325, 44))
    draw.text((790, 205), '本轮实时库存', font=shop_title_font(26), fill='#ffdc79')
    draw.rounded_rectangle((32, 260, 1048, height-72), radius=26, fill='#292d2e')
    y = 262
    for index, item, titles, prices, details, row_height in rows:
        target = index in selected
        paste_asset(card, 'item-on.png' if target else 'item.png',
                    (margin, y, width-2*margin, row_height))
        cx, cy = margin+86, y+80
        paste_asset(card, 'item-bg-on.png' if target else 'item-bg.png',
                    (cx-70, cy-68, 140, 135))
        data = icons.get(item['image'])
        if not data:
            raise ValueError('Missing current product icon')
        with Image.open(io.BytesIO(data)) as original:
            if original.width * original.height > 16_000_000:
                raise ValueError('Product image too large')
            icon = ImageOps.contain(original.convert('RGBA'), (124, 124))
        card.paste(icon, (cx-icon.width//2, cy-icon.height//2), icon)
        limit = f'限购 {item["limit"]}'
        limit_width = max(140, int(dummy.textlength(limit, font=shop_font(21)))+24)
        if limit_width <= 156:
            paste_asset(card, 'txt-bg.png', (cx-limit_width//2, y+132, limit_width, 34))
            draw.text((cx, y+136), limit, anchor='mt', font=shop_font(21), fill='#fff29f')
        if target:
            draw.text((width-margin-24, y+18), '订阅命中', anchor='rt', font=shop_title_font(21), fill='#8d4b13')
        x, ty = margin+178, y+20
        for title in titles:
            draw.text((x, ty), title, font=shop_title_font(32), fill=ink)
            ty += 40
        for price in prices:
            if item.get('currency', '洛克贝') == '洛克贝':
                coin_x = x + int(dummy.textlength(price, font=shop_font(26))) + 12
                if coin_x + 34 < width-margin-20:
                    paste_asset(card, 'icon.png', (coin_x, ty+2, 34, 32))
            draw.text((x, ty+4), price, font=shop_font(26), fill='#393939')
            ty += 34
        ty += 14
        for line in details:
            draw.text((x, ty), line, font=shop_font(23), fill=muted)
            ty += 31
        y += row_height+16
    captured = datetime.fromtimestamp(snapshot['fetchedAt'], BJ)
    generated = datetime.fromtimestamp(now, BJ)
    draw.rounded_rectangle((margin, y, width-margin, y+48), radius=16, fill='#292d2e')
    draw.text((margin+18, y+8), f'采集 {captured:%H:%M:%S} · 制图 {generated:%H:%M:%S} · 倒计时以制图时刻为准', font=shop_font(22), fill='#fffaee')
    out = io.BytesIO()
    card.save(out, format='PNG', optimize=True)
    return out.getvalue()
