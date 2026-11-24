"""Decode QQ merged-record references from protocol fields, never message intent."""
import json
import xml.etree.ElementTree as ET


def forward_reference(segment):
    """Return a normalized forward data dict, or None for ordinary cards."""
    if not isinstance(segment, dict):
        return None
    kind = str(segment.get('type') or '').lower()
    data = segment.get('data')
    if kind == 'forward' and isinstance(data, dict):
        return data
    if kind not in {'json', 'xml'}:
        return None
    value = data.get('data', data.get('content', data)) if isinstance(data, dict) else data
    if len(str(value)) > 256 * 1024:
        return None
    if isinstance(value, dict) or isinstance(value, str) and value.lstrip().startswith('{'):
        try:
            card = json.loads(value) if isinstance(value, str) else value
        except (ValueError, TypeError):
            return None
        if not isinstance(card, dict) or card.get('app') != 'com.tencent.multimsg':
            return None
        meta = card.get('meta')
        detail = meta.get('detail') if isinstance(meta, dict) else None
        if isinstance(detail, dict):
            return {'id': str(detail.get('resid') or detail.get('m_resid') or '').strip()}
        return {'id': ''}
    if isinstance(value, str) and value.lstrip().startswith('<'):
        try:
            root = ET.fromstring(value)
        except (ET.ParseError, ValueError):
            return None
        if root.tag == 'msg' and root.get('serviceID') == '35':
            return {'id': str(root.get('m_resid') or '').strip()}
    return None
