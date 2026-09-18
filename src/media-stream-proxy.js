import { once } from 'node:events';
import { MAX_MEDIA_BYTES, isMediaTooLargeError, mediaTooLargeError } from './media-limits.js';

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
        // Race CDN candidates for the initial request. Some Bilibili UPOS
        // nodes accept the connection but deliver bytes very slowly; waiting
        // for that node before trying backups makes QQ appear to hang. The
        // first healthy response wins and losing requests are aborted.
        let upstream;
        if (bytes === 0 && urls.length > 1 && url === urls[0]) {
          const racers = urls.map((candidate) => {
            const raceController = new AbortController();
            const raceTimer = setTimeout(() => raceController.abort(), timeoutMs);
            return fetchImpl(candidate, { headers: { ...headers }, signal: raceController.signal })
              .then((result) => {
                if (!result.ok || !result.body) throw new Error('视频源 HTTP ' + result.status);
                return { result, raceController, raceTimer };
              })
              .catch((error) => { clearTimeout(raceTimer); raceController.abort(); throw error; });
          });
          const winner = await Promise.any(racers);
          racers.forEach((promise) => promise.then(({ raceController, raceTimer }) => {
            if (raceController !== winner.raceController) { clearTimeout(raceTimer); raceController.abort(); }
          }).catch(() => {}));
          upstream = winner.result;
          clearTimeout(winner.raceTimer);
        } else {
          upstream = await fetchImpl(url, { headers, signal: controller.signal });
        }
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
          if (totalBytes !== null && totalBytes > MAX_MEDIA_BYTES) {
            throw mediaTooLargeError(totalBytes);
          }
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
          if (bytes + value.length > MAX_MEDIA_BYTES) {
            throw mediaTooLargeError(bytes + value.length);
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
      const tooLarge = isMediaTooLargeError(lastError);
      response.writeHead(tooLarge ? 413 : 502, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        ok: false,
        error: tooLarge ? 'MEDIA_TOO_LARGE' : 'MEDIA_UNAVAILABLE',
        message: tooLarge ? '这个视频超过 500MB，建议点击分享前往平台观看。' : '视频源暂时不可用',
      }));
    }
  } finally {
    response.removeListener('close', onClose);
  }
}

// Establish the CDN connection as soon as a remote media item is resolved.
// The request is cancelled after the first body chunk; QQ will open the same
// public proxy URL later, while DNS/TLS/CDN edge selection is already warm.
export async function warmRemoteMedia(media, { fetchImpl = fetch, timeoutMs = 2_000, logger = console } = {}) {
  const urls = [...new Set([media?.remoteUrl, ...(media?.backupUrls || [])].filter(Boolean))];
  if (!urls.length) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await Promise.any(urls.map((url) => fetchImpl(url, {
      headers: media.requestHeaders || {}, signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      await reader.read();
      await reader.cancel().catch(() => {});
      return new URL(url).hostname;
    })));
    logger.info(`视频链路预热完成：host=${result}`);
    return true;
  } catch (error) {
    logger.debug?.(`视频链路预热跳过：${error.message}`);
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
