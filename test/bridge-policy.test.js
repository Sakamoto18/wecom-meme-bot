import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('QQ Bridge 先禁用默认 LLM，并在回复经过 RespondStage 后停止传播', async () => {
  const source = await readFile(
    new URL('../astrbot_plugin_longtu_bridge/main.py', import.meta.url),
    'utf8',
  );
  const handlerStart = source.indexOf('async def on_qq_message');
  const handlerEnd = source.indexOf('\n    async def terminate', handlerStart);
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);

  const handler = source.slice(handlerStart, handlerEnd);
  const disableDefaultLlmIndex = handler.indexOf('event.call_llm = True');
  const yieldReplyIndex = handler.indexOf('yield event.chain_result(reply_chain)');
  const stopIndex = handler.indexOf('event.stop_event()');
  const slashBranchIndex = handler.indexOf('if self._is_slash_command(event):');
  const routingIndex = handler.indexOf('should_reply = self._should_reply(event)');

  assert.notEqual(disableDefaultLlmIndex, -1);
  assert.ok(disableDefaultLlmIndex < slashBranchIndex);
  assert.ok(disableDefaultLlmIndex < routingIndex);
  assert.notEqual(yieldReplyIndex, -1);
  assert.notEqual(stopIndex, -1);
  assert.ok(stopIndex > yieldReplyIndex);
  assert.equal(handler.match(/event\.stop_event\(\)/g)?.length, 1);
  assert.match(handler, /finally:\s+event\.stop_event\(\)/);
  assert.match(handler, /if observe_only and not response\["messages"\]:/);
  assert.match(
    handler,
    /if not bool\(response\.get\("active_reply"\)\):\s+reply_chain = self\._reply_prefix/,
  );
  assert.match(source, /not str\(cls\._raw_text\(event\) or ""\)\.strip\(\)/);
  assert.match(source, /not cls\._plain_component_text\(components\)/);
  assert.match(source, /getattr\(component, "text", ""\)/);
  assert.match(handler, /PURE_BOT_MENTION_TEXT\s+if pure_bot_mention/);
  assert.match(source, /ALLOWED_BRIDGE_SLASH_COMMANDS\s*=\s*\{[^}]*"\/stop"/);
  assert.match(handler, /self\._is_allowed_bridge_slash_command\(event\)/);
  assert.doesNotMatch(handler, /and not str\(text or ""\)\.strip\(\)/);
});

test('QQ Bridge 在默认 LLM 启动前兜底接管漏过 Adapter handler 的纯 At', async () => {
  const source = await readFile(
    new URL('../astrbot_plugin_longtu_bridge/main.py', import.meta.url),
    'utf8',
  );
  const hookStart = source.indexOf('async def rescue_pure_mention_before_default_llm');
  const handlerStart = source.indexOf('async def on_qq_message');
  assert.notEqual(hookStart, -1);
  assert.notEqual(handlerStart, -1);

  const hook = source.slice(hookStart, handlerStart);
  assert.match(
    source.slice(0, hookStart),
    /@filter\.on_waiting_llm_request\(priority=1000\)/,
  );
  assert.match(hook, /self\._is_pure_bot_mention\(event\)/);
  assert.match(hook, /self\._request_backend/);
  assert.match(hook, /await event\.send\(MessageChain\(chain=reply_chain\)\)/);
  assert.match(hook, /event\.call_llm = True/);
  assert.match(hook, /event\.stop_event\(\)/);
  assert.ok(hook.indexOf('await event.send') < hook.lastIndexOf('event.stop_event()'));
});
