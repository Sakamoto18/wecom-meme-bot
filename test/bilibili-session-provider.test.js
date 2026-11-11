import test from 'node:test';
import assert from 'node:assert/strict';
import { createBilibiliSessionProvider } from '../src/bilibili-session-provider.js';

test('默认登录态等待超过旧的 800ms，退出登录不返回 Cookie', async t => {
  let timeout;
  t.mock.method(AbortSignal, 'timeout', ms => { timeout=ms;return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({logged_in:true,cookie:'test=session'})));
  const provider=createBilibiliSessionProvider({providerUrl:'http://provider/resolve'});
  assert.equal(await provider(),'test=session');assert.equal(timeout,8000);
  globalThis.fetch=async()=>new Response(JSON.stringify({logged_in:false,cookie:'stale=session'}));
  assert.equal(await provider(),'');
});
