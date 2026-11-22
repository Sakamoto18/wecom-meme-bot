"""Resolve report labels from the official group, with verified binding fallback."""
import asyncio
import json
import time


def group_binding(config, group_id):
    prefix = f'qqofficial:{config.get("official_trial_appid")}:group:'
    if not str(group_id).startswith(prefix):
        return None
    raw = config.get('official_trial_group_bindings') or '{}'
    data = json.loads(raw) if isinstance(raw, str) else raw
    value = data.get(str(group_id)[len(prefix):], {}) if isinstance(data, dict) else {}
    return value if isinstance(value, dict) else {}


async def request_group_info(platform, openid):
    from botpy.http import Route
    return await platform.client.api._http.request(
        Route('GET', '/v2/groups/{group_openid}/info', group_openid=openid))


async def live_group_name(bridge, group_id):
    manager = getattr(getattr(bridge, 'context', None), 'platform_manager', None)
    appid = str(bridge.config.get('official_trial_appid') or '')
    platform = next((p for p in getattr(manager, 'platform_insts', [])
                     if p.meta().name == 'qq_official' and str(getattr(p, 'appid', '')) == appid), None)
    if not platform:
        return ''
    cache = getattr(bridge, '_official_report_name_cache', None)
    if cache is None:
        cache = bridge._official_report_name_cache = {}
    now = time.monotonic()
    cached = cache.get(group_id)
    if cached and now < cached[0]:
        return cached[1]
    openid = str(group_id).removeprefix(f'qqofficial:{appid}:group:')
    name = ''
    try:
        info = await asyncio.wait_for(request_group_info(platform, openid), timeout=8)
        if (isinstance(info, dict) and info.get('group_openid') == openid
                and isinstance(info.get('group_name'), str)):
            name = info['group_name'].strip()
    except Exception:
        # QQ currently restricts this endpoint to approved apps (11253).
        # Failure must still allow the verified mapping to resolve the report.
        pass
    cache[group_id] = (now + 300, name)
    return name


async def official_group_names(bridge, group_ids):
    names = {}
    for group_id in group_ids[:20]:
        binding = group_binding(bridge.config, group_id)
        if binding is None:
            continue
        name = await live_group_name(bridge, group_id)
        qq = str(binding.get('qq_group_id') or '')
        if not name:
            name = str(binding.get('name') or '')
            if qq.isdigit():
                found = await bridge._group_names([qq])
                name = found.get(qq) or name
        names[str(group_id)] = name or (f'QQ群 {qq}' if qq else '官方 QQ 群')
    return names
