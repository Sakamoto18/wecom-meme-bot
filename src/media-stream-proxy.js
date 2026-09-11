import { once } from 'node:events';

// Every URL is an alternative for the same MP4 from the playback API.
// Keep the client response open while resuming a stalled CDN from its byte offset.
export async function proxyRemoteMedia(request, response, media, {
  fetchImpl = fetch, logger = console, timeoutMs = 8_000,
} = {}) {
  const urls = [...new Set([media.remoteUrl, ...(media.backupUrls || [])].filter(Boolean))];
  const started = Date.now();
  const disconnected = new AbortController();
  const onClose = () => disconnected.abort();
  response.once('close', onClose);
  let bytes = 0;
  let expectedBytes = null;
  let rangeStart = 0;
  let rangeEnd = null;
  let totalBytes = null;
  let lastError;
  try {
    for (const url of urls) {
      if (disconnected.signal.aborted) return;
      const controller = new AbortController();
      const abort = () => controller.abort();
      disconnected.signal.addEventListener('abort', abort, { once: true });
      let timer;
      let reader;
      const resetTimeout = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error('视频源读取超时')), timeoutMs);
      };
      const host = new URL(url).hostname;
      try {
        const headers = { ...media.requestHeaders };
        if (bytes > 0) {
          if (expectedBytes === null) throw new Error('视频长度未知，不能安全续传');
          headers.range = 'bytes=' + (rangeStart + bytes) + '-' + rangeEnd;
        } else if (request.headers.range) headers.range = request.headers.range;
        resetTimeout();
        const upstream = await fetchImpl(url, { headers, signal: controller.signal });
        if (!upstream.ok || !upstream.body) throw new Error('视频源 HTTP ' + upstream.status);
        const contentRange = upstream.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/u);
        const length = upstream.headers.get('content-length');
        if (bytes > 0) {
          if (upstream.status !== 206 || !contentRange
              || Number(contentRange[1]) !== rangeStart + bytes
              || Number(contentRange[2]) !== rangeEnd
              || Number(contentRange[3]) !== totalBytes) {
            throw new Error('备用视频源未返回正确的续传范围');
          }
        } else {
          rangeStart = contentRange ? Number(contentRange[1]) : 0;
          expectedBytes = contentRange ? Number(contentRange[2]) - rangeStart + 1
            : (length !== null && /^\d+$/u.test(length) ? Number(length) : null);
          rangeEnd = expectedBytes === null ? null : rangeStart + expectedBytes - 1;
          totalBytes = contentRange ? Number(contentRange[3]) : expectedBytes;
        }
        reader = upstream.body.getReader();
        while (true) {
          resetTimeout();
          const { done, value } = await reader.read();
          clearTimeout(timer);
          if (done) {
            if (expectedBytes !== null && bytes !== expectedBytes) throw new Error('视频源提前断开');
            if (!response.headersSent) throw new Error('视频源内容为空');
            response.end();
            logger.info('视频传输完成：host=' + host + ' bytes=' + bytes + ' duration_ms=' + (Date.now() - started));
            return;
          }
          if (expectedBytes !== null && bytes + value.length > expectedBytes) {
            throw new Error('视频源超出声明长度');
          }
          if (!response.headersSent) {
            const outgoing = {
              'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
              'Cache-Control': 'private, max-age=600', 'Content-Disposition': 'inline',
              'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
            };
            for (const name of ['content-length', 'content-range']) {
              const value = upstream.headers.get(name);
              if (value) outgoing[name] = value;
            }
            response.writeHead(upstream.status, outgoing);
            logger.info('视频传输开始：host=' + host + ' first_byte_ms=' + (Date.now() - started));
          }
          const writable = response.write(Buffer.from(value));
          bytes += value.length;
          if (!writable) await once(response, 'drain', { signal: disconnected.signal });
        }
      } catch (error) {
        lastError = error;
        if (disconnected.signal.aborted) return;
        logger.warn('视频源切换：host=' + host + ' bytes=' + bytes + ' reason=' + error.message);
      } finally {
        clearTimeout(timer);
        controller.abort();
        await reader?.cancel().catch(() => {});
        disconnected.signal.removeEventListener('abort', abort);
      }
    }
    logger.warn('视频传输失败：bytes=' + bytes + ' duration_ms=' + (Date.now() - started)
      + ' reason=' + (lastError?.message || '没有视频源'));
    if (response.headersSent) response.destroy();
    else {
      response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: '视频源暂时不可用' }));
    }
  } finally {
    response.removeListener('close', onClose);
  }
}
