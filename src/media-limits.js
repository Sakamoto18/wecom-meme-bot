/** Limits shared by media extraction and the user-facing QQ result. */
export const MAX_MEDIA_BYTES = 500 * 1024 * 1024;
export const MAX_MEDIA_EXTRACTION_MS = 8 * 60 * 1000;

export function mediaTooLargeError(size = 0) {
  const value = Number(size);
  const error = new Error(
    `视频文件超过 500 MiB${Number.isFinite(value) && value > 0 ? `（约 ${(value / 1024 / 1024).toFixed(1)} MiB）` : ''}`,
  );
  error.code = 'MEDIA_TOO_LARGE';
  error.size = Number.isFinite(value) ? value : 0;
  return error;
}

export function mediaExtractionTimeoutError() {
  const error = new Error('视频提取超过 8 分钟，已中断');
  error.code = 'MEDIA_EXTRACTION_TIMEOUT';
  return error;
}

export function isMediaTooLargeError(error) {
  return error?.code === 'MEDIA_TOO_LARGE' || /视频文件超过 500 MiB/u.test(String(error?.message || error));
}

export function isMediaExtractionTimeoutError(error) {
  return error?.code === 'MEDIA_EXTRACTION_TIMEOUT'
    || /视频提取超过 8 分钟|媒体下载超时/u.test(String(error?.message || error));
}
