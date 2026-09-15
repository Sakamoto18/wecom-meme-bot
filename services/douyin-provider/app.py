import asyncio, os
from fastapi import FastAPI
from pydantic import BaseModel
from playwright.async_api import async_playwright
app=FastAPI(); context=None; lock=asyncio.Lock()
class Req(BaseModel): url:str
@app.get('/healthz')
async def health(): return {'status':'ok'}
async def get_context():
 global context
 if context: return context
 pw=await async_playwright().start(); context=await pw.chromium.launch_persistent_context(os.getenv('DOUYIN_PROFILE','/data/profile'),headless=True,args=['--disable-dev-shm-usage']); return context
@app.post('/resolve')
async def resolve(req:Req):
 async with lock:
  try:
   page=await (await get_context()).new_page(); await page.goto(req.url,wait_until='domcontentloaded',timeout=20000); await page.wait_for_timeout(1200)
   d=await page.evaluate('''() => ({title:document.title,desc:document.querySelector('meta[name=description]')?.content||'',cover:document.querySelector('meta[property=og:image]')?.content||'',video:document.querySelector('meta[property=og:video]')?.content||''})'''); await page.close()
   if not d.get('video'): return {'status':'failed','msg':'未获取到视频地址，请先完成抖音登录'}
   return {'status':'success','data':{'media_type':'video','video_url':d['video'],'cover':d['cover'],'title':d['title'],'description':d['desc']}}
  except Exception as e: return {'status':'failed','msg':str(e)}
