import asyncio, os, html
from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel
from playwright.async_api import async_playwright
app=FastAPI(); context=None; login_page=None; lock=asyncio.Lock()
def is_real_video_url(url):
 low=str(url or '').lower()
 if not low or 'uuu_265.mp4' in low:
  return False
 return bool('.mp4' in low or '.m3u8' in low or 'playwm' in low or 'play/' in low)
class Req(BaseModel): url:str
@app.get('/healthz')
async def health(): return {'status':'ok'}
async def get_context():
 global context
 if context: return context
 pw=await async_playwright().start(); context=await pw.chromium.launch_persistent_context(os.getenv('DOUYIN_PROFILE','/data/profile'),headless=False,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']); return context
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
   ctx=await get_context(); page=await ctx.new_page()
   video_requests=[]
   def capture(response):
    url=response.url
    low=url.lower()
    if any(token in low for token in ('.mp4', '.m3u8', 'playwm', 'play/')):
     if url not in video_requests: video_requests.append(url)
   page.on('response', capture)
   await page.goto(req.url,wait_until='domcontentloaded',timeout=25000)
   await page.wait_for_timeout(1800)
   try:
    await page.locator('video').first.scroll_into_view_if_needed(timeout=2000)
    await page.locator('video').first.evaluate("v => { try { v.muted=true; v.play().catch(()=>{}); } catch (_) {} }")
   except Exception: pass
   await page.wait_for_timeout(2500)
   d=await page.evaluate('''() => {
    const resources=performance.getEntriesByType('resource').map(x=>x.name);
    const videos=[...document.querySelectorAll('video')].flatMap(v=>[v.currentSrc,v.src]);
    const meta=(name)=>document.querySelector(`meta[name="${name}"]`)?.content||'';
    const avatar=document.querySelector('img[alt]:not([alt="icon"])')?.currentSrc
      || [...document.images].find(img=>/aweme-avatar/i.test(img.src))?.currentSrc || '';
    const author=document.querySelector('img[alt]:not([alt="icon"])')?.alt || '';
    const keywords=meta('keywords').split(',').map(x=>x.trim()).filter(Boolean);
    const html=document.documentElement?.outerHTML || '';
    const urls=[...html.matchAll(/https?:\\/\\/[^\"'\s<>]+/g)].map(m=>m[0].replaceAll('\\/','/'));
    const candidates=[...videos,...resources,...urls].filter(Boolean);
    const video=candidates.find(u=>{ const low=String(u).toLowerCase(); return low.indexOf('uuu_265.mp4')<0 && (/\.(mp4|m3u8)(?:[?#]|$)/i.test(u)||/playwm|play\//i.test(u)); }) || '';
    return {title:document.title,desc:meta('description'),cover:meta('lark:url:video_cover_image_url') || document.querySelector('meta[property="og:image"]')?.content||'',video,author,avatar,tags:keywords};
   }''')
   if not d.get('video'):
    real_requests=[url for url in video_requests if is_real_video_url(url)]
    if real_requests: d['video']=real_requests[-1]
   await page.close()
   if not d.get('video'): return {'status':'failed','msg':'未获取到视频地址，请先完成抖音登录'}
   d['video']=html.unescape(d['video'])
   return {'status':'success','data':{'media_type':'video','video_url':d['video'],'cover':d['cover'],'title':d['title'],'description':d['desc'],'author':d.get('author',''),'avatar_url':d.get('avatar',''),'tags':d.get('tags',[])}}
  except Exception as e: return {'status':'failed','msg':str(e)}
