import path from 'node:path';

// This overlay is used only by the Windows launcher. The Linux .env stays intact.
export function nativeEnvironment(root, saved, overrides = {}, inherited = {}) {
  const env = { ...inherited, ...saved };
  for (const [key, value] of Object.entries(saved)) {
    if (!/(?:_FILE|_PATH|_DIR|_DIRECTORY)$/.test(key)) continue;
    for (const prefix of ['/app/', '/opt/longtu-qq-bot/']) {
      if (value.startsWith(prefix)) env[key] = path.win32.join(root, value.slice(prefix.length));
    }
  }
  Object.assign(env, {
    QQ_API_HOST: '127.0.0.1',
    QQ_API_PORT: '8787',
    LONGTU_QQ_API_URL: 'http://127.0.0.1:8787/v1/qq/message',
    LONGTU_QQ_API_TOKEN: saved.QQ_API_TOKEN || '',
    LONGTU_QQ_INTERNAL_SEND_HOST: '127.0.0.1',
    QQ_MEDIA_PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
    DOUYIN_PROVIDER_URL: 'http://127.0.0.1:9001/resolve',
    BILIBILI_PROVIDER_URL: 'http://127.0.0.1:9001',
    XHS_PROVIDER_URL: 'http://127.0.0.1:9001/xhs/resolve',
    QQ_MEDIA_CACHE_DIRECTORY: path.win32.join(root, 'data/windows/media-cache'),
    // Browser cookies encrypted on Linux cannot reliably be opened on Windows.
    DOUYIN_PROFILE: path.win32.join(root, 'data/windows/douyin-profile'),
    XHS_PROFILE: path.win32.join(root, 'data/windows/xhs-profile'),
    BILIBILI_AUTH_STATE: path.win32.join(root, 'data/windows/bilibili-auth/state.json'),
    QQ_MEDIA_YTDLP_COMMAND: path.win32.join(root, '.venv-windows/Scripts/yt-dlp.exe'),
    XHS_PYTHON_COMMAND: path.win32.join(root, '.venv-windows/Scripts/python.exe'),
    QQ_MEDIA_FFMPEG_COMMAND: 'C:\\tools\\ffmpeg\\bin\\ffmpeg.exe',
    QQ_IMAGE_OCR_COMMAND: 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
    LONGTU_OCR_COMMAND: 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
    LONGTU_OCR_LANGUAGES: saved.LONGTU_OCR_LANGUAGES || 'chi_sim+eng',
    MEDIA_BROWSER_CHANNEL: 'msedge',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
  }, overrides);
  // Windows Python's CRT interprets TZ as a POSIX string, not an IANA zone.
  // Use the server's Windows time zone (China Standard Time) and the application's
  // explicit ZoneInfo settings; forwarding the Linux TZ value shifts Python clocks.
  delete env.TZ;
  const pathKeys = Object.keys(env).filter(key => key.toLowerCase() === 'path');
  const inheritedPath = pathKeys.map(key => env[key]).filter(Boolean).join(';');
  for (const key of pathKeys) delete env[key];
  const toolDirs = [env.QQ_MEDIA_FFMPEG_COMMAND, env.QQ_IMAGE_OCR_COMMAND]
    .filter(command => command && path.win32.isAbsolute(command))
    .map(command => path.win32.dirname(command));
  env.Path = [...new Set(toolDirs), inheritedPath].filter(Boolean).join(';');
  if (!Object.hasOwn(overrides, 'LONGTU_QQ_API_TOKEN')) {
    env.LONGTU_QQ_API_TOKEN = env.QQ_API_TOKEN;
  }
  return env;
}
