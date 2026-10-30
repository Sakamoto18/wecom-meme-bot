import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { nativeEnvironment } from './environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (process.platform !== 'win32') throw new Error('此入口仅用于 Windows；Linux 继续使用原 Compose/启动命令。');
const saved = parse(readFileSync(path.join(root, '.env.qq')));
const overrideFile = path.join(root, '.env.windows');
const overrides = existsSync(overrideFile) ? parse(readFileSync(overrideFile)) : {};
const env = nativeEnvironment(root, saved, overrides, process.env);
if (!env.QQ_API_TOKEN || env.QQ_API_TOKEN.length < 32) throw new Error('恢复的 .env.qq 缺少有效 QQ_API_TOKEN。');
const python = path.join(root, '.venv-windows/Scripts/python.exe');
const astrbot = env.ASTRBOT_ROOT;
const modes = {
  node: { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', 'src/qq-api.js'], cwd: root },
  provider: { command: python, args: ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '9001'], cwd: path.join(root, 'services/douyin-provider') },
  relay: { command: process.execPath, args: ['scripts/windows/onebot-forward-relay.mjs'], cwd: root },
  // AstrBot uses its own virtual environment; its dependency versions differ.
  astrbot: astrbot ? { command: path.join(astrbot, '.venv/Scripts/python.exe'), args: ['main.py'], cwd: astrbot } : null,
  napcat: env.NAPCAT_ROOT && /^\d+$/.test(env.NAPCAT_ACCOUNT || '')
    ? { command: path.join(env.NAPCAT_ROOT, 'NapCatWinBootMain.exe'), args: [env.NAPCAT_ACCOUNT], cwd: env.NAPCAT_ROOT }
    : null,
};
const service = modes[process.argv[2]];
if (!service) throw new Error('用法：node scripts/windows/run.mjs node|provider|astrbot|napcat|relay（需配置 ASTRBOT_ROOT 或 NAPCAT_ROOT/NAPCAT_ACCOUNT）。');
if (!existsSync(service.command)) throw new Error(`运行环境尚未安装：${service.command}`);
// dotenv in qq-api must not reload the Linux settings over the native overlay.
env.QQ_ENV_FILE = path.join(root, '.env.qq');
const child = spawn(service.command, service.args, { cwd: service.cwd, env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
