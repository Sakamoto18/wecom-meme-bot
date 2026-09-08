import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LINK_PATTERN = /https?:\/\/(?:www\.)?(?:xhslink\.com|xiaohongshu\.com\/(?:discovery\/)?item\/)[^\s<>"']+/iu;
const DEFAULT_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../parser/xhs_resolver.py',
);

async function sendResult(message, text, send) {
  if (typeof send === 'function') return send(message.group_id, text, message);
  if (typeof message.reply === 'function') return message.reply(text);
  if (typeof message.send === 'function') return message.send(text);
  if (typeof message.bot?.call_action === 'function') {
    return message.bot.call_action('send_group_msg', {
      group_id: message.group_id,
      message: text,
    });
  }
  return { group_id: message.group_id, text };
}

export async function handleXhsLink(message, options = {}) {
  const raw = String(message?.raw_message ?? message?.message ?? '');
  const match = raw.match(LINK_PATTERN);
  if (!match) return { handled: false };
  const timeoutMs = Number(options.timeoutMs ?? 6_000);
  const child = (options.spawnImpl ?? spawn)(
    options.pythonCommand ?? 'python3',
    [options.scriptPath ?? DEFAULT_SCRIPT, '--url', match[0], '--timeout', String(Math.max(0.1, timeoutMs / 1000))],
    { env: { ...process.env, ...(options.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let settled = false;
  return new Promise((resolve) => {
    let timer;
    const finish = async (text, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await sendResult(message, text, options.send);
      resolve({ handled: true, ...result });
    };
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', () => {});
    child.on('error', () => finish('链路异常，请联系管理员', { status: 'error' }));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish('链路异常，请联系管理员', { status: 'error' });
      try {
        const result = JSON.parse(stdout.trim());
        if (result.status === 'success' && result.data?.video_url) {
          return finish(`🎬 视频直链：${result.data.video_url}`, { status: 'success', data: result.data });
        }
        return finish(String(result.msg || '链路异常，请联系管理员'), { status: 'failed' });
      } catch {
        return finish('链路异常，请联系管理员', { status: 'error' });
      }
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish('解析超时，请稍后重试', { status: 'timeout' });
    }, timeoutMs);
  });
}
