import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
import unittest

spec=importlib.util.spec_from_file_location('bilibili_card', Path(__file__).resolve().parents[1]/'scripts/bilibili-card-search.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class AnonymousCardTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self):
        page=SimpleNamespace(goto=AsyncMock(),wait_for_selector=AsyncMock(),close=AsyncMock())
        async def get(url, **kwargs):
            data=({'numPages':1,'result':[{'bvid':'BV1VbyxzsEpo','title':'<em>训练</em>!'}]}
                  if '/search/type?' in url else {'bvid':'BV1VbyxzsEpo','title':'训练!',
                    'owner':{'name':'内松兔司'},'pic':'https://i0.hdslb.com/a.jpg','pages':[{}]})
            return SimpleNamespace(ok=True,json=AsyncMock(return_value={'code':0,'data':data}))
        ctx=SimpleNamespace(new_page=AsyncMock(return_value=page),cookies=AsyncMock(return_value=[]),
                            close=AsyncMock(),request=SimpleNamespace(get=AsyncMock(side_effect=get)))
        browser=SimpleNamespace(new_context=AsyncMock(return_value=ctx))
        return browser,ctx,page

    async def test_fresh_context_without_storage_state_and_uploader_query(self):
        browser,ctx,page=self.fixture()
        result=await module.card_candidates(browser,'训练!','内松兔司')
        self.assertEqual(result['candidates'][0]['bvid'],'BV1VbyxzsEpo')
        self.assertNotIn('storage_state',browser.new_context.call_args.kwargs)
        self.assertIn('%E5%86%85%E6%9D%BE%E5%85%94%E5%8F%B8',page.goto.call_args.args[0])
        self.assertTrue(all('cookie' not in c.kwargs.get('headers',{}) for c in ctx.request.get.call_args_list))
        ctx.cookies.assert_not_awaited()
        ctx.close.assert_awaited_once()

    async def test_navigation_failure_closes_context(self):
        browser,ctx,page=self.fixture();page.goto.side_effect=TimeoutError()
        with self.assertRaises(TimeoutError):await module.card_candidates(browser,'训练!')
        ctx.cookies.assert_not_awaited()
        ctx.close.assert_awaited_once()
