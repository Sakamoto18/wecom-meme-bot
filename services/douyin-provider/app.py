import asyncio, os
from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel
from playwright.async_api import async_playwright
app=FastAPI(); context=None; login_page=None; lock=asyncio.Lock()
class Req(BaseModel): url:str
@app.get('/healthz')
async def health(): return {'status':'ok'}
async def get_context():
 global context
 if context: return context
 pw=await async_playwright().start(); context=await pw.chromium.launch_persistent_context(os.getenv('DOUYIN_PROFILE','/data/profile'),headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']); return context
@app.get('/login.png')
async def login_png():
 global login_page
 ctx=await get_context()
 if login_page is None or login_page.is_closed():
  login_page=await ctx.new_page(); await login_page.goto('https://www.douyin.com/',wait_until='domcontentloaded',timeout=20000)
 await login_page.wait_for_timeout(1000)
 return Response(await login_page.screenshot(type='png',full_page=False),media_type='image/png')
@app.get('/login-status')
async def login_status():
 if login_page is None or login_page.is_closed(): return {'logged_in':False}
 text=(await login_page.locator('body').inner_text())[:5000]
 return {'logged_in': bool('登录' not in text or '我的' in text or '退出登录' in text)}
@app.post('/resolve')
async def resolve(req:Req):
 async with lock:
  try:
   page=await (await get_context()).new_page(); await page.goto(req.url,wait_until='domcontentloaded',timeout=20000); await page.wait_for_timeout(1200)
   d=await page.evaluate('''() => ({title:document.title,desc:document.querySelector('meta[name=description]')?.content||'',cover:document.querySelector('meta[property=og:image]')?.content||'',video:document.querySelector('meta[property=og:video]')?.content||''})'''); await page.close()
   if not d.get('video'): return {'status':'failed','msg':'未获取到视频地址，请先完成抖音登录'}
   return {'status':'success','data':{'media_type':'video','video_url':d['video'],'cover':d['cover'],'title':d['title'],'description':d['desc']}}
  except Exception as e: return {'status':'failed','msg':str(e)}
