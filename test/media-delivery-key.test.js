import test from 'node:test';
import assert from 'node:assert/strict';
import { QqBotService } from '../src/qq-service.js';
import { ConversationStore } from '../src/conversation-store.js';

test('多群 B站同 CID 同画质复用 QQ 视频，分 P 和画质不能串', async () => {
  let media = { url: 'http://qq-bot:8787/v1/qq/media/first', cid: '101', quality: 64 };
  const service = new QqBotService({ conversationStore: new ConversationStore(), webSearchEnabled: false,
    logger: { info() {}, warn() {} },
    mediaResolver: { enabled: true, async resolve() { return media; } },
  });
  const share = async (group, text = 'https://b23.tv/example') => (await service.handleMessage({
    message_type: 'group', group_id: group, user_id: 'test', media_share: true, text,
  })).messages[0];
  const first = await share('group-a');
  media = { ...media, url: 'http://qq-bot:8787/v1/qq/media/second' };
  const second = await share('group-b', 'https://b23.tv/another-link');
  assert.equal(first.mediaCacheKey, second.mediaCacheKey);
  media.cid = '202';
  assert.notEqual(first.mediaCacheKey, (await share('group-a')).mediaCacheKey);
  media.cid = '101'; media.quality = 80;
  assert.notEqual(first.mediaCacheKey, (await share('group-a')).mediaCacheKey);
});

test('小红书和抖音按已解析的视频地址复用，不会把不同视频混在一起', async () => {
  let url = 'https://cdn.example/first.mp4?signature=original';
  const service = new QqBotService({ conversationStore: new ConversationStore(), webSearchEnabled: false,
    logger: { info() {}, warn() {} }, mediaResolver: { enabled: true, async resolve() { return { url }; } },
  });
  const share = async (text, group) => (await service.handleMessage({
    message_type: 'group', group_id: group, user_id: 'test', media_share: true, text,
  })).messages[0].mediaCacheKey;
  for (const text of ['https://xhslink.cn/o/example', 'https://v.douyin.com/example/']) {
    const first = await share(text, 'group-a');
    assert.equal(first, await share(text, 'group-b'));
    url += 'changed';
    assert.notEqual(first, await share(text, 'group-a'));
  }
});
