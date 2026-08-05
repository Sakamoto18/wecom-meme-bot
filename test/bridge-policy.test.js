import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('QQ Bridge 在任何分支判断前停止 AstrBot 默认事件链', async () => {
  const source = await readFile(
    new URL('../astrbot_plugin_longtu_bridge/main.py', import.meta.url),
    'utf8',
  );
  const handlerStart = source.indexOf('async def on_qq_message');
  const handlerEnd = source.indexOf('\n    async def terminate', handlerStart);
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);

  const handler = source.slice(handlerStart, handlerEnd);
  const stopIndex = handler.indexOf('event.stop_event()');
  const slashBranchIndex = handler.indexOf('if self._is_slash_command(event):');
  const routingIndex = handler.indexOf('should_reply = self._should_reply(event)');

  assert.notEqual(stopIndex, -1);
  assert.ok(stopIndex < slashBranchIndex);
  assert.ok(stopIndex < routingIndex);
  assert.equal(handler.match(/event\.stop_event\(\)/g)?.length, 1);
  assert.match(handler, /if observe_only and not response\["messages"\]:/);
});
