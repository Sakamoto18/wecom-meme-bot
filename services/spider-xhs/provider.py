import os
import requests
import re
from page_content import note_url_from_response, parse_public_note, normalize_note
from fastapi import FastAPI
from pydantic import BaseModel
from apis.xhs_pc_apis import XHS_Apis
from xhs_utils.xhs_pc import XHSPcAuth
app=FastAPI(); api=None
class Req(BaseModel): url:str
@app.get('/healthz')
def health(): return {'status':'ok','configured':bool(os.getenv('COOKIES'))}
def get_api():
 global api
 if api is None: api=XHS_Apis(XHSPcAuth.from_cookie(os.getenv('COOKIES',''))).bootstrap()
 return api
@app.post('/resolve')
def resolve(req:Req):
 try:
  target=req.url
  if 'xhslink.com' in target:
   response=requests.get(target,allow_redirects=True,timeout=10)
   target=note_url_from_response(response)
   content=parse_public_note(response.text,response.url)
   if content: return {'status':'success','data':content}
  ok,msg,raw=get_api().get_note_info(target)
  if not ok:return {'status':'failed','msg':str(msg)}
  d=(raw or {}).get('data') or {}; c=(d.get('items') or [{}])[0].get('note_card') or {}
  return {'status':'success','data':normalize_note(c)}
 except Exception as e:return {'status':'failed','msg':str(e)}
