"""Share one original QQ video upload, then reuse QQ's native message storage."""
import asyncio
import time


class VideoForwardRejected(RuntimeError):
    """An explicit API rejection: falling back cannot duplicate a sent video."""


class VideoDeliveryCache:
    def __init__(self, ttl_seconds=600, max_entries=256, clock=time.monotonic, logger=None):
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self.clock = clock
        self.logger = logger
        self.completed = {}
        self.inflight = {}

    def _log(self, text):
        if self.logger:
            self.logger.info(text)

    def _prune(self):
        now = self.clock()
        for key, entry in list(self.completed.items()):
            if entry[0] <= now:
                self.completed.pop(key, None)
        while len(self.completed) > self.max_entries:
            self.completed.pop(next(iter(self.completed)))

    async def _upload(self, key, send_original):
        try:
            receipt = await send_original()
            if not isinstance(receipt, dict) or not receipt.get('message_id'):
                raise RuntimeError('QQ 视频接口未返回消息回执')
            self.completed[key] = (self.clock() + self.ttl_seconds, receipt)
            self._prune()
            return receipt
        finally:
            self.inflight.pop(key, None)

    async def deliver(self, account, media_key, send_original, forward_cached):
        key = (str(account), str(media_key))
        while True:
            self._prune()
            entry = self.completed.get(key)
            if entry is not None:
                try:
                    result = await forward_cached(entry[1]['message_id'])
                    self._log('视频发送缓存命中：复用 QQ 原生视频消息')
                    return result
                except VideoForwardRejected:
                    # Missing/recalled source or unsupported action: upload once
                    # anew. Timeout/connection errors are deliberately NOT caught;
                    # QQ may already be sending, so retrying could duplicate it.
                    if self.completed.get(key) is entry:
                        self.completed.pop(key, None)
                    self._log('视频原生复用被拒绝：回退正常发送')
                    # A concurrent waiter may already have replaced this entry.
                    continue
            task = self.inflight.get(key)
            if task is not None:
                self._log('视频发送共用任务：等待同一视频首次上传')
                try:
                    # Cancelling one event must not cancel other groups' upload.
                    await asyncio.shield(task)
                except Exception:
                    # A failed first destination must not poison other groups.
                    pass
                continue
            self._log('视频发送缓存未命中：启动一次上传')
            task = asyncio.create_task(self._upload(key, send_original))
            self.inflight[key] = task
            # Retrieve failures even when every event waiter has been cancelled.
            task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
            return await asyncio.shield(task)

    async def close(self):
        tasks = list(self.inflight.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.inflight.clear()
        self.completed.clear()
