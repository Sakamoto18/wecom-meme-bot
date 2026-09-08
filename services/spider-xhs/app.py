"""Small HTTP boundary for a separately authorized XHS provider.

The container deliberately does not implement signing, device spoofing, or
captcha bypass. A licensed/authorized Spider_XHS deployment can be connected
through XHS_UPSTREAM_URL later.
"""
import os
from typing import Any
import httpx
from fastapi import FastAPI
from pydantic import BaseModel, HttpUrl

app = FastAPI(title="spider-xhs-provider", version="0.1.0")
UPSTREAM = os.getenv("XHS_UPSTREAM_URL", "").strip()
TIMEOUT = float(os.getenv("XHS_UPSTREAM_TIMEOUT", "15"))

class ResolveRequest(BaseModel):
    url: HttpUrl

@app.get("/healthz")
async def healthz():
    return {"status": "ok", "configured": bool(UPSTREAM)}

def normalize(payload: Any) -> dict:
    if not isinstance(payload, dict):
        return {"status": "failed", "msg": "provider 返回格式无效"}
    if payload.get("status") in ("success", "failed"):
        return payload
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    result = {k: data[k] for k in ("video_url", "cover", "images", "title", "description", "desc") if data.get(k)}
    if result.get("video_url") or result.get("images"):
        return {"status": "success", "data": result}
    return {"status": "failed", "msg": payload.get("msg", "未找到可发送的媒体内容")}

@app.post("/v1/xhs/resolve")
async def resolve(req: ResolveRequest):
    if not UPSTREAM:
        return {"status": "failed", "msg": "provider 未配置授权上游，已保留现有回退链路"}
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
            response = await client.post(UPSTREAM, json={"url": str(req.url)})
            response.raise_for_status()
            return normalize(response.json())
    except Exception as exc:
        return {"status": "failed", "msg": f"provider 请求失败：{type(exc).__name__}"}
