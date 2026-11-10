"""Deterministic, paginated usage report PNGs; all chart values are CNY."""
import io
import math
from datetime import datetime
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw
from .video_card import card_font, draw_rich_text, text_width, text_clusters

COLORS = ('#5379E7', '#27A987', '#9872DF', '#F1A343')
INK = '#202C43'
MUTED = '#778398'
WIDTH = 1200
PAGE_SIZE = 12
TZ = ZoneInfo('Asia/Shanghai')


def number(value):
    try:
        value = float(value or 0)
        return value if math.isfinite(value) and value > 0 else 0.0
    except (TypeError, ValueError):
        return 0.0


def money(value):
    value = number(value)
    return f'¥{value:,.2f}' if value >= .01 or value == 0 else f'¥{value:.6f}'.rstrip('0')


def parts(row):
    return [number(row.get('uncachedInputCostCny')) + number(row.get('jevUncachedInputCostCny')),
            number(row.get('cachedInputCostCny')) + number(row.get('jevCachedInputCostCny')),
            number(row.get('outputCostCny')) + number(row.get('jevOutputCostCny')),
            number(row.get('searchEstimatedCostCny'))]


def total(row):
    return (number(row.get('estimatedCostCny')) + number(row.get('jevEstimatedCostCny'))
            + number(row.get('searchEstimatedCostCny')))


def percent(numerator, denominator):
    return f'{number(numerator) / number(denominator) * 100:.1f}%' if number(denominator) else '—'


def clipped(text, size, width):
    font = card_font(size)
    chunks = text_clusters(str(text).replace('\n', ' '))
    if text_width(''.join(chunks), font) <= width:
        return ''.join(chunks)
    while chunks and text_width(''.join(chunks) + '…', font) > width:
        chunks.pop()
    return ''.join(chunks) + '…'


def usd(value):
    return f'${number(value):,.2f}'


EXA_STATE_LABELS = {
    'exhausted': '已用完',
    'credits-exhausted': '已用完',
    'rate-limited': '限流冷却',
    'invalid': 'key 失效',
}


def exa_key_lines(exa):
    """Rows for the Exa key section in pool order; empty when no key is configured.

    The key in use is the pool's current key, or the first usable key in
    order when that one has run out (the pool moves on to it next).
    """
    keys = list((exa or {}).get('keys') or [])
    if not keys:
        return []
    usable = [key for key in keys if key.get('state', 'available') == 'available']
    current = next((key for key in usable if key.get('current')), usable[0] if usable else None)
    rows = []
    for key in keys:
        state = key.get('state', 'available')
        status = EXA_STATE_LABELS.get(state) or ('使用中' if key is current else '待用')
        detail = (f"免费 {usd(key.get('monthlyRemainingUsd'))} + 赠送 {usd(key.get('bonusRemainingUsd'))}"
                  f" · 本月已用 {usd(key.get('spentUsd'))} · {int(number(key.get('calls')))} 次")
        rows.append({
            'label': str(key.get('label') or f"Key {key.get('number')}"),
            'status': status,
            'remaining': f"{usd(key.get('remainingUsd'))} / {usd(key.get('budgetUsd'))}",
            'detail': detail,
            'active': key is current,
            'exhausted': status == '已用完',
        })
    return rows


def exa_key_header(exa):
    keys = list((exa or {}).get('keys') or [])
    order = ' > '.join(str(key.get('label') or f"Key {key.get('number')}") for key in keys)
    reset = datetime.fromtimestamp(number((exa or {}).get('resetAt')) / 1000, TZ)
    return f'按 {order} 顺序使用，用完顺延；{reset:%m-%d %H:%M} 重置'


def exa_key_note(exa):
    note = '余额是估算：先扣每月免费额度、再扣赠送额度，按本 bot 记录的花费计算；Exa 没有余额接口，以后台为准。'
    calls = int(number((exa or {}).get('unattributedCalls')))
    if calls:
        note += f" 另有 {calls} 次 {usd((exa or {}).get('unattributedSpentUsd'))} 未记录 key。"
    return note


def catchup_lines(run):
    """Title and item lines for the overnight meme catch-up panel."""
    if not isinstance(run, dict) or not run.get('day'):
        return None, []
    items = [item for item in run.get('items') or [] if isinstance(item, dict)]
    learned = sum(1 for item in items if item.get('status') == 'learned')
    minutes = sum(number(item.get('seconds')) for item in items) / 60
    title = f"每日补课 {run['day']} · 学会 {learned}/{len(items)} · 看视频 {minutes:.1f} 分钟"
    if run.get('status') == 'failed':
        return title, [f"补课失败：{run.get('error') or '未知原因'}"]
    if not items:
        return title, ['群聊和 B 站梗百科都没找到要学的新梗']
    source = {'group': '群聊', 'bilibili': 'B站梗百科'}
    rows = []
    for item in items:
        tag = f"［{source[item['source']]}］" if item.get('source') in source else ''
        if item.get('status') == 'learned':
            detail = item.get('meaning') or '已入梗库'
        else:
            detail = f"没学会：{item.get('error') or '证据不足'}"
        rows.append(f"{tag}{item.get('term')}：{detail}")
    return title, rows


def report_rows(report, names):
    rows = {str(row['groupId']): dict(row) for row in report.get('groups', [])}
    for group_id in names:
        rows.setdefault(str(group_id), {'groupId': str(group_id)})
    result = sorted(rows.values(), key=lambda row: (-total(row), str(row['groupId'])))
    for row in result:
        official = str(row['groupId']).startswith('qqofficial:')
        row['label'] = names.get(str(row['groupId'])) or ('官方 QQ 群' if official else str(row['groupId']))
        row['displayId'] = 'QQ 官方 Bot' if official else str(row['groupId'])
    private = dict(report.get('privateUsage') or {})
    if any(number(private.get(k)) for k in ('requests', 'llmCalls', 'searchCalls', 'jevCalls')) or total(private):
        result.append({**private, 'label': '私聊 / 未归属群', 'groupId': '独立统计'})
    return result


def render_usage_report(report, names=None):
    """Returns PNG bytes per page. Zero rows still produce a useful empty report."""
    names = names or {}
    rows = report_rows(report, names)
    # Private usage is a summary attached to the last group page, not another
    # group consuming a pagination slot (12 groups + private must stay one PNG).
    private_rows = [row for row in rows if row['groupId'] == '独立统计']
    group_rows = [row for row in rows if row['groupId'] != '独立统计']
    pages = [group_rows[i:i + PAGE_SIZE] for i in range(0, len(group_rows), PAGE_SIZE)] or [[]]
    pages[-1].extend(private_rows)
    pricing = report.get('pricing') or {}
    jev = pricing.get('jev') or {}
    search = pricing.get('search') or {}
    totals = report.get('totals') or {}
    grand_total = number(pricing.get('estimatedCostCny')) + number(jev.get('jevEstimatedCostCny')) + number(search.get('searchEstimatedCostCny'))
    axis_max = max([sum(parts(row)) for row in rows] + [0.01])
    start = datetime.fromtimestamp(number(report.get('startAt')) / 1000, TZ)
    end = datetime.fromtimestamp(number(report.get('endAt')) / 1000, TZ)
    period = f'{start:%Y.%m.%d %H:%M} — {end:%m.%d %H:%M}  北京时间'
    missing = int(number(search.get('searchUnpricedCalls')))
    unknown = int(number(search.get('searchUnknownCalls')))
    unpriced_models = int(number(pricing.get('unpricedCalls')) + number(jev.get('jevUnpricedCalls')))
    incomplete = missing or unknown or unpriced_models
    search_label = 'Exa 搜索 · 已计价' if missing or unknown else 'Exa 搜索'
    search_value = money(search.get('searchEstimatedCostCny'))
    if (missing or unknown) and not number(search.get('searchPricedCalls')):
        search_value = '未计价' if missing else '待确认'
    rates = search.get('searchExchangeRates') or []
    rate_text = ' / '.join(f'{number(rate):g}' for rate in rates) if rates else f"{number(search.get('configuredUsdToCny')) or 7.2:g}（配置值）"
    notes = [f'美元兑人民币：{rate_text}；按每次调用记录的汇率换算。',
             'Exa：优先使用接口费用，否则按官网估算；本地搜索缓存命中 ¥0。',
             '缓存输入是实际支出；金额为用量估算，未扣除赠送额度或合同优惠。']
    if incomplete:
        notes.append(f'未计入金额：历史/未知搜索 {missing} 次 · 扣费待确认 {unknown} 次 · 模型未计价 {unpriced_models} 次。')
    if number(report.get('dataAvailableFrom')) > number(report.get('startAt')):
        available = datetime.fromtimestamp(number(report['dataAvailableFrom']) / 1000, TZ)
        notes.append(f'记录始于 {available:%m-%d %H:%M}，本时段数据不完整。')
    exa = report.get('exaKeys') or {}
    exa_rows = exa_key_lines(exa)
    catchup_title, catchup_rows = catchup_lines(report.get('videoLearningCatchup'))
    output = []
    for page_index, subset in enumerate(pages):
        chart_bottom = 532 + max(1, len(subset)) * 112
        # The key panel goes on the last page, between the chart and the notes.
        exa_height = 112 + len(exa_rows) * 58 if exa_rows and page_index == len(pages) - 1 else 0
        catchup_height = 84 + len(catchup_rows) * 34 if catchup_title and page_index == len(pages) - 1 else 0
        notes_top = chart_bottom + 31 + exa_height + catchup_height
        height = notes_top + 69 + len(notes) * 31
        image = Image.new('RGB', (WIDTH, height), '#F2F5FA')
        draw = ImageDraw.Draw(image)
        def text(x, y, value, size=24, color=INK, width=None):
            value = clipped(value, size, width) if width else str(value)
            draw_rich_text(image, (x, y), value, card_font(size), color)
        draw.rounded_rectangle((32, 30, 1168, 277), radius=24, fill='#17263E')
        text(64, 54, '龙玉涛 Bot · 用量日报', 34, '#FFFFFF')
        text(64, 104, period, 21, '#B0BED2')
        text(64, 155, '已计价总费用' if incomplete else '当日总费用', 23, '#B0BED2')
        text(64, 189, money(grand_total), 51, '#FFFFFF')
        text(650, 166, f"消息 {int(number(totals.get('requests'))):,}   模型调用 {int(number(totals.get('llmCalls')) + number(jev.get('jevCalls'))):,}", 24, '#FFFFFF', 460)
        text(650, 211, f"搜索 API {int(number(totals.get('searchCalls'))):,}   缓存命中 {int(number(totals.get('searchCacheHits'))):,}", 23, '#B0BED2', 460)
        metrics = [('主模型', money(pricing.get('estimatedCostCny')), COLORS[0]),
                   ('Jev', money(jev.get('jevEstimatedCostCny')), COLORS[2]),
                   (search_label, search_value, COLORS[3]),
                   ('模型输入缓存命中', percent(number(totals.get('cachedInputTokens')) + number(jev.get('jevCachedInputTokens')), number(totals.get('inputTokens')) + number(jev.get('jevInputTokens'))), COLORS[1])]
        for i, (label, value, color) in enumerate(metrics):
            x = 32 + i * 288
            draw.rounded_rectangle((x, 297, x + 272, 400), radius=16, fill='white')
            text(x + 20, 311, label, 21, MUTED)
            text(x + 20, 345, value, 31, color, 234)
        draw.rounded_rectangle((32, 420, 1168, chart_bottom + 10), radius=18, fill='white')
        text(56, 441, '各群费用分布', 27)
        text(930, 447, f'{page_index + 1} / {len(pages)} 页', 21, MUTED)
        for i, (label, color) in enumerate(zip(('未缓存输入', '缓存输入', '模型输出', 'Exa 搜索'), COLORS)):
            x = 56 + i * 264
            draw.rounded_rectangle((x, 492, x + 16, 508), radius=4, fill=color)
            text(x + 26, 483, label, 21, MUTED)
        if not subset:
            text(56, 554, '本时段暂无用量记录', 25, MUTED)
        for i, row in enumerate(subset):
            y = 534 + i * 112
            text(56, y, row['label'], 24, width=1040)
            text(56, y + 38, row.get('displayId', row['groupId']), 19, MUTED, 265)
            x = 342
            draw.rounded_rectangle((x, y + 39, 971, y + 60), radius=5, fill='#F0F3F8')
            for amount, color in zip(parts(row), COLORS):
                length = amount / axis_max * 629
                if length > 0:
                    draw.rectangle((x, y + 39, x + length, y + 60), fill=color)
                    x += length
            text(988, y + 28, money(total(row)), 23, width=150)
            inputs = number(row.get('inputTokens')) + number(row.get('jevInputTokens'))
            cached = number(row.get('cachedInputTokens')) + number(row.get('jevCachedInputTokens'))
            calls = int(number(row.get('searchCalls')))
            hits = int(number(row.get('searchCacheHits')))
            details = f'输入缓存 {percent(cached, inputs)}   ·   搜索 {calls} 次 / 缓存 {hits} 次'
            if number(row.get('searchUnpricedCalls')) + number(row.get('searchUnknownCalls')):
                details += '   ·   含未计价搜索'
            text(342, y + 69, details, 18, MUTED, 780)
            if i < len(subset) - 1:
                draw.line((56, y + 103, 1140, y + 103), fill='#EDF0F5')
        if exa_height:
            top = chart_bottom + 30
            draw.rounded_rectangle((32, top, 1168, top + exa_height - 20), radius=18, fill='white')
            text(56, top + 20, 'Exa Key 剩余额度', 27)
            text(330, top + 27, exa_key_header(exa), 19, MUTED, 810)
            for i, row in enumerate(exa_rows):
                y = top + 70 + i * 58
                color = MUTED if row['exhausted'] else (COLORS[1] if row['active'] else INK)
                draw.rounded_rectangle((56, y + 6, 68, y + 18), radius=6, fill=color)
                text(80, y, f"{i + 1}. {row['label']}", 24, INK, 230)
                text(320, y + 2, row['status'], 21, color, 120)
                text(430, y, row['remaining'], 24, color, 220)
                text(660, y + 3, row['detail'], 18, MUTED, 490)
            text(56, top + exa_height - 52, exa_key_note(exa), 17, MUTED, 1090)
        if catchup_height:
            top = chart_bottom + 30 + exa_height
            draw.rounded_rectangle((32, top, 1168, top + catchup_height - 20), radius=18, fill='white')
            text(56, top + 18, catchup_title, 25, INK, 1080)
            for i, row in enumerate(catchup_rows):
                text(56, top + 60 + i * 34, row, 19, MUTED, 1090)
        for i, note in enumerate(notes):
            text(48, notes_top + i * 31, note, 19, MUTED, 1100)
        text(48, height - 41, 'EXA.AI/DOCS/ADMIN/PRICING   ·   CNY   ·   费用按调用时段统计', 17, MUTED)
        buffer = io.BytesIO()
        image.save(buffer, format='PNG', optimize=True)
        output.append(buffer.getvalue())
    return output
