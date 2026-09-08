#!/usr/bin/env python3
"""Resolve an XHS share through an externally supplied, authorized detail API.

This module deliberately does not implement or reverse engineer X-Sign. The
caller must inject any headers issued by its own or an authorized provider.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import Any
from urllib.parse import urlparse

import requests

NOTE_ID_PATTERN = re.compile(r"/(?:discovery/)?item/([a-zA-Z0-9]+)")
DEFAULT_USER_AGENT = "LongtuShareResolver/1.0"


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def build_signed_headers(raw_params: dict, timestamp: str) -> dict:
    """# TODO: 在此处对接动态签名服务或手动抓包替换。

    签名算法不在本项目中实现。该函数只保留稳定的可插拔边界。
    """
    del raw_params, timestamp
    return {}


def injected_headers(headers_json: str = "") -> dict[str, str]:
    raw = headers_json or os.getenv("XHS_HEADERS_JSON", "")
    result: dict[str, str] = {}
    if raw:
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("headers 必须是 JSON 对象")
        result.update({str(key): str(item) for key, item in value.items()})
    result.setdefault(
        "User-Agent",
        os.getenv("XHS_USER_AGENT", DEFAULT_USER_AGENT),
    )
    cookie = os.getenv("XHS_COOKIE", "").strip()
    if cookie:
        result.setdefault("Cookie", cookie)
    return result


def extract_note_id(final_url: str) -> str:
    match = NOTE_ID_PATTERN.search(urlparse(final_url).path)
    if not match:
        raise ValueError("短链跳转后未找到 note_id")
    return match.group(1)


def iter_objects(value: Any):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from iter_objects(item)
    elif isinstance(value, list):
        for item in value:
            yield from iter_objects(item)


def first_url(value: Any) -> str:
    if isinstance(value, str) and value.startswith(("https://", "http://")):
        return value
    if isinstance(value, list):
        for item in value:
            found = first_url(item)
            if found:
                return found
    if isinstance(value, dict):
        for key in ("url", "master_url", "masterUrl", "url_default", "urlDefault"):
            found = first_url(value.get(key))
            if found:
                return found
    return ""


def parse_detail(payload: Any) -> dict[str, Any] | None:
    candidates: list[tuple[int, str]] = []
    cover = ""
    watermarked = False
    for item in iter_objects(payload):
        if not cover:
            for key in ("cover", "cover_url", "coverUrl", "image"):
                cover = first_url(item.get(key))
                if cover:
                    break
        for key, value in item.items():
            normalized = str(key).lower()
            if "watermark" in normalized and value not in (False, 0, "0", "false", None, ""):
                watermarked = True
            if normalized not in {
                "video_url", "videourl", "play_url", "playurl",
                "master_url", "masterurl", "url", "stream", "streams",
            }:
                continue
            url = first_url(value)
            if not url or ".mp4" not in url.lower():
                continue
            bitrate = (
                item.get("height")
                or item.get("bitrate")
                or item.get("bit_rate")
                or item.get("bitRate")
                or 0
            )
            try:
                score = int(float(bitrate))
            except (TypeError, ValueError):
                score = 0
            candidates.append((score, url))
    if not candidates:
        return None
    candidates.sort(key=lambda entry: entry[0], reverse=True)
    return {
        "video_url": candidates[0][1],
        "cover": cover,
        "watermarked": watermarked,
    }


def resolve(
    share_url: str,
    timeout: float,
    api_url: str = "",
    headers_json: str = "",
) -> dict[str, Any]:
    headers = injected_headers(headers_json)
    redirect = requests.get(
        share_url,
        allow_redirects=True,
        timeout=timeout,
        headers={"User-Agent": headers["User-Agent"]},
    )
    redirect.raise_for_status()
    note_id = extract_note_id(redirect.url)
    endpoint_template = api_url or os.getenv("XHS_DETAIL_API_URL", "").strip()
    if not endpoint_template:
        return {"status": "failed", "msg": "未配置已授权的详情接口"}
    timestamp = str(int(time.time() * 1000))
    request_body = {"source_note_id": note_id}
    headers.update(build_signed_headers(request_body, timestamp))
    endpoint = endpoint_template.replace("{note_id}", note_id)
    response = requests.post(
        endpoint, json=request_body, headers=headers, timeout=timeout
    )
    if response.status_code in {401, 403, 412, 429}:
        return {"status": "failed", "msg": "签名失效或风控拦截"}
    response.raise_for_status()
    try:
        payload = response.json()
    except requests.JSONDecodeError:
        return {"status": "failed", "msg": "详情接口返回非 JSON"}
    if payload.get("code") == -100 or not payload.get("data"):
        return {"status": "failed", "msg": "签名过期，请更新请求头配置"}
    data = parse_detail(payload.get("data"))
    if not data:
        return {"status": "failed", "msg": "签名失效或风控拦截"}
    return {"status": "success", "data": data}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--api-url", default="")
    parser.add_argument("--headers-json", default="")
    args = parser.parse_args()
    try:
        emit(resolve(args.url, max(0.1, args.timeout), args.api_url, args.headers_json))
        return 0
    except (requests.RequestException, ValueError, json.JSONDecodeError) as error:
        emit({"status": "failed", "msg": str(error)})
        return 0
    except Exception:
        emit({"status": "failed", "msg": "链路异常，请联系管理员"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
