import asyncio
import importlib.util
import unittest
from types import SimpleNamespace
from astrbot_plugin_longtu_bridge.official_forward import parse_record, read_record, image_url, download_image, has_record_header

URL = 'https://multimedia.nt.qq.com.cn/download?fileid=test&rkey=private'
BODY = ('[群聊的聊天记录]\n=== 消息 1 ===\n[发送者] 甲\n'
        '[消息内容] 第一张是报价\n[附件1] 类型:图片 文件名:a.png URL:' + URL + '\n'
        '=== 消息 2 ===\n[发送者] 乙\n[消息内容] 第二张是结果\n'
        '[附件1] 类型:图片 文件名:b.png URL:' + URL + '2')
PNG = b'\x89PNG\r\n\x1a\n' + b'pixels'
QUOTED_BODY = ('=== 消息 1 ===\n[消息内容] [群聊的聊天记录]\n'
               '[消息类型] 引用消息\n[关联消息]\n--- 第1条 ---\n'
               '    [发送者] 甲\n    [附件1] 类型:图片 文件名:a.png URL:' + URL + '\n'
               '--- 第2条 ---\n    [发送者] 乙\n'
               '    [附件1] 类型:图片 文件名:b.png URL:' + URL + '2')

class RecordTests(unittest.IsolatedAsyncioTestCase):
    def test_sender_owned_header_is_protocol_not_a_generic_title_only(self):
        body = BODY.replace('[群聊的聊天记录]', '[烤全鸡的聊天记录]')
        record = parse_record('看看这条\n' + body)
        self.assertTrue(has_record_header(body))
        self.assertEqual(record['text'], '看看这条')
        self.assertEqual(record['lines'][0], '[烤全鸡的聊天记录]')
        self.assertEqual(len(record['attachments']), 2)
        wrapped = QUOTED_BODY.replace('[群聊的聊天记录]', '[烤全鸡的聊天记录]')
        self.assertEqual(parse_record(wrapped)['text'], '')
        self.assertFalse(has_record_header('帮我看烤全鸡的聊天记录'))
        self.assertTrue(has_record_header('[烤全鸡的聊天记录]'))
        self.assertIsNone(parse_record('[烤全鸡的聊天记录]'))

    async def test_quoted_associated_records_download_images_in_order(self):
        record = parse_record(QUOTED_BODY)
        self.assertIsNotNone(record)
        self.assertEqual(record['text'], '')
        async def fetch(session, url):
            return PNG + url[-1:].encode()
        text, images = await read_record(record, None, downloader=fetch)
        self.assertEqual(len(images), 2)
        self.assertLess(text.index('[图片#1]'), text.index('[发送者] 乙'))
        self.assertGreater(text.index('[图片#2]'), text.index('[发送者] 乙'))
        self.assertIn('=== 消息 1 ===', text)
        self.assertNotIn('https://', text)

    async def test_preserves_node_order_and_image_indices_without_urls(self):
        record = parse_record('请分析\n' + BODY)
        self.assertEqual(record['text'], '请分析')
        async def fetch(session, url):
            if url == URL: await asyncio.sleep(.01)
            return PNG + url[-1:].encode()
        text, images = await read_record(record, None, downloader=fetch)
        self.assertEqual(len(images), 2)
        self.assertIn('[图片#1]', text);self.assertIn('[图片#2]', text)
        self.assertLess(text.index('[图片#1]'), text.index('第二张'))
        self.assertNotIn('https://', text);self.assertNotIn('rkey', text)
        self.assertIn('[发送者] 甲', text)

    async def test_failed_first_image_does_not_shift_node_attribution(self):
        async def fetch(session, url):
            if url == URL: raise TimeoutError()
            return PNG
        text, images = await read_record(parse_record(BODY), None, downloader=fetch)
        self.assertEqual(len(images), 1)
        self.assertLess(text.index('图片未读取'), text.index('第二张'))
        self.assertGreater(text.index('[图片#1]'), text.index('第二张'))

    async def test_no_arbitrary_url_or_prose_routing(self):
        for text in ['帮我看聊天记录 '+URL, '=== 消息 1 ===\n'+URL, '[群聊的聊天记录]没节点']:
            self.assertIsNone(parse_record(text))
        for url in ['https://multimedia.nt.qq.com.cn.evil.test/a','http://127.0.0.1/a',
                    'https://user:pass@multimedia.nt.qq.com.cn/a','https://multimedia.nt.qq.com.cn:8443/a']:
            self.assertEqual(image_url(url), '')
        async def fetch(*args):self.fail('untrusted image URL must not be fetched')
        text, images = await read_record(parse_record(BODY.replace(URL, 'http://127.0.0.1/a')), None, downloader=fetch)
        self.assertFalse(images);self.assertIn('图片未读取', text)

    async def test_limits_and_bounded_concurrency(self):
        record=parse_record('[群聊的聊天记录]\n'+'\n'.join(
            f'=== 消息 {i} ===\n[附件1] 类型:图片 URL:{URL}{i}' for i in range(1,27)))
        active=peak=0
        async def fetch(*args):
            nonlocal active,peak
            active+=1;peak=max(peak,active);await asyncio.sleep(.001);active-=1
            return PNG
        text, images=await read_record(record,None,downloader=fetch)
        self.assertEqual(len(images),24);self.assertLessEqual(peak,3)
        self.assertEqual(text.count('图片未读取'),2)

    @unittest.skipUnless(importlib.util.find_spec('aiohttp'), 'requires AstrBot aiohttp environment')
    async def test_stream_reader_collects_all_chunks_and_rejects_redirects(self):
        chunks=[PNG[:5],PNG[5:]]
        class Response:
            status=200;content_length=None
            async def __aenter__(self):return self
            async def __aexit__(self,*args):pass
            @property
            def content(self):return self
            async def iter_chunked(self,_):
                for chunk in chunks:yield chunk
        response=Response()
        class Session:
            closed=False
            def get(self,url,**kwargs):
                assert kwargs['allow_redirects'] is False
                return response
        self.assertEqual(await download_image(Session(),URL),PNG)
        response.status=302
        self.assertEqual(await download_image(Session(),URL),b'')
        response.status=200;chunks[:]=[b'<html>error</html>']
        self.assertEqual(await download_image(Session(),URL),b'')
