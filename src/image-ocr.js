import { spawn } from 'node:child_process';

const MAX_OCR_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_WORD_CONFIDENCE = 35;
const MIN_LINE_CONFIDENCE = 50;

function cleanOcrLine(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/[\s|]+/g, '')
    .replace(/^[^\p{L}\p{N}\p{Script=Han}]+|[^\p{L}\p{N}\p{Script=Han}，。！？!?]+$/gu, '')
    .trim();
}

function isUsefulOcrAlias(value) {
  if (!value || value.length < 2 || value.length > 32 || /^\d+$/.test(value)) return false;
  const meaningful = value.match(/[\p{L}\p{N}\p{Script=Han}]/gu)?.length ?? 0;
  return meaningful >= 2;
}

export function parseTesseractTsv(tsv) {
  const groupedLines = new Map();
  for (const rawRow of String(tsv ?? '').split(/\r?\n/).slice(1)) {
    if (!rawRow.trim()) continue;
    const columns = rawRow.split('\t');
    if (columns.length < 12 || columns[0] !== '5') continue;
    const confidence = Number.parseFloat(columns[10]);
    const text = columns.slice(11).join('\t').trim();
    if (!text || !Number.isFinite(confidence) || confidence < MIN_WORD_CONFIDENCE) continue;
    const key = columns.slice(1, 5).join(':');
    const line = groupedLines.get(key) ?? { words: [], confidenceTotal: 0, weight: 0 };
    const weight = Math.max(1, text.length);
    line.words.push(text);
    line.confidenceTotal += confidence * weight;
    line.weight += weight;
    groupedLines.set(key, line);
  }

  const aliases = [];
  for (const line of groupedLines.values()) {
    if (line.confidenceTotal / line.weight < MIN_LINE_CONFIDENCE) continue;
    const alias = cleanOcrLine(line.words.join(''));
    if (isUsefulOcrAlias(alias)) aliases.push(alias);
  }
  const combined = cleanOcrLine(aliases.join(''));
  if (aliases.length > 1 && isUsefulOcrAlias(combined)) aliases.push(combined);
  return [...new Set(aliases)].slice(0, 12);
}

function runTesseract(filePath, options = {}) {
  const command = String(options.command ?? '').trim();
  if (!command) throw new Error('未配置 OCR 命令');
  const languages = String(options.languages ?? '').trim() || 'chi_sim+eng';
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1_000, Math.min(options.timeoutMs, 60_000))
    : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, [
      filePath,
      'stdout',
      '-l',
      languages,
      '--psm',
      '11',
      'tsv',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`OCR 超过 ${timeoutMs}ms 未完成`)));
    }, timeoutMs);
    timeout.unref();

    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OCR_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(() => reject(new Error('OCR 输出超过大小限制')));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (errorBytes >= 32_768) return;
      stderr.push(chunk);
      errorBytes += chunk.length;
    });
    child.once('error', (error) => {
      finish(() => reject(new Error(`无法执行 OCR：${error.message}`)));
    });
    child.once('close', (code) => {
      finish(() => {
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 300);
          reject(new Error(`OCR 进程退出码 ${code}${detail ? `：${detail}` : ''}`));
          return;
        }
        resolve(Buffer.concat(stdout).toString('utf8'));
      });
    });
  });
}

export async function recognizeImageTextAliases(filePath, options = {}) {
  const tsv = await runTesseract(filePath, options);
  return parseTesseractTsv(tsv);
}
