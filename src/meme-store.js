import { createHash, randomInt } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createSmileyPng } from './png.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MEDIA_CACHE_TTL_MS = 48 * 60 * 60 * 1000;
const FILE_INDEX_TTL_MS = 60 * 1000;
const DEFAULT_LONGTU_LIMIT = 800;
const DEFAULT_LONGTU_MAX_SCORE = 0.6;
const STREAM_IMAGE_EXTENSIONS = new Set(['.png', '.jpg']);

export function detectImageExtension(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return '.png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return '.jpg';
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return '.gif';
    }
  }
  return null;
}

export async function createBuiltInMeme() {
  return createSmileyPng();
}

export function createImageReplyItem(meme) {
  const extension = detectImageExtension(meme?.buffer ?? Buffer.alloc(0));
  if (!STREAM_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error('流式图文回复只支持 JPG/PNG 图片');
  }

  return {
    msgtype: 'image',
    image: {
      base64: meme.buffer.toString('base64'),
      md5: createHash('md5').update(meme.buffer).digest('hex'),
    },
  };
}

export class MemeStore {
  constructor(directories, options = {}) {
    this.directories = directories.filter(Boolean);
    this.longtuIndexPath = options.longtuIndexPath;
    this.longtuExclusionsPath = options.longtuExclusionsPath;
    this.longtuSourceDirectory = options.longtuSourceDirectory;
    this.trustedLongtuDirectory = options.trustedLongtuDirectory;
    this.longtuLimit = options.longtuLimit ?? DEFAULT_LONGTU_LIMIT;
    this.longtuMaxScore = options.longtuMaxScore ?? DEFAULT_LONGTU_MAX_SCORE;
    this.mediaCache = new Map();
    this.fileIndex = [];
    this.fileIndexExpiresAt = 0;
    this.longtuCandidates = null;
    this.longtuExclusions = null;
    this.trustedManifestDetected = false;
    this.longtuIndexWarningShown = false;
    this.lastPickedPath = new Map();
  }

  async scanDirectory(directory) {
    const imageFiles = [];
    const pendingDirectories = [directory];

    while (pendingDirectories.length > 0) {
      const current = pendingDirectories.pop();
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EACCES') {
          continue;
        }
        throw error;
      }

      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pendingDirectories.push(entryPath);
        } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          imageFiles.push(entryPath);
        }
      }
    }

    return imageFiles;
  }

  async refreshFileIndex() {
    if (this.fileIndexExpiresAt > Date.now()) {
      return this.fileIndex;
    }

    const groups = await Promise.all(this.directories.map((directory) => this.scanDirectory(directory)));
    this.fileIndex = groups.flat();
    this.fileIndexExpiresAt = Date.now() + FILE_INDEX_TTL_MS;
    return this.fileIndex;
  }

  async getStats() {
    const [files, longtuCandidates] = await Promise.all([
      this.refreshFileIndex(),
      this.loadLongtuCandidates(),
    ]);
    return {
      directories: this.directories,
      imageCount: files.length,
      longtuImageCount: longtuCandidates.length,
    };
  }

  isInsideLongtuSource(filePath) {
    if (!this.longtuSourceDirectory) {
      return true;
    }

    const relativePath = path.relative(this.longtuSourceDirectory, filePath);
    return relativePath !== '..'
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath);
  }

  async loadLongtuExclusions() {
    if (this.longtuExclusions) {
      return this.longtuExclusions;
    }
    if (!this.longtuExclusionsPath) {
      this.longtuExclusions = new Set();
      return this.longtuExclusions;
    }

    try {
      const exclusions = JSON.parse(await readFile(this.longtuExclusionsPath, 'utf8'));
      this.longtuExclusions = new Set(
        Array.isArray(exclusions.excludedSha256) ? exclusions.excludedSha256 : [],
      );
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`无法读取龙图排除表：${error.message}`);
      }
      this.longtuExclusions = new Set();
    }
    return this.longtuExclusions;
  }

  async loadLongtuCandidates() {
    if (this.longtuCandidates) {
      return this.longtuCandidates;
    }

    const trustedCandidates = await this.loadTrustedLongtuCandidates();
    if (trustedCandidates.length > 0 || this.trustedManifestDetected) {
      this.longtuCandidates = trustedCandidates;
      return this.longtuCandidates;
    }

    if (!this.longtuIndexPath) {
      this.longtuCandidates = [];
      return this.longtuCandidates;
    }

    try {
      const [index, exclusions] = await Promise.all([
        readFile(this.longtuIndexPath, 'utf8').then(JSON.parse),
        this.loadLongtuExclusions(),
      ]);
      const entries = Array.isArray(index.entries)
        ? index.entries.slice(0, this.longtuLimit)
        : [];
      const seenHashes = new Set();
      const candidates = [];

      for (let position = 0; position < entries.length; position += 1) {
        const entry = entries[position];
        const score = Number(entry?.score);
        if (!entry?.path
          || !Number.isFinite(score)
          || score > this.longtuMaxScore
          || !this.isInsideLongtuSource(entry.path)) {
          continue;
        }

        try {
          const buffer = await readFile(entry.path);
          if (!detectImageExtension(buffer)) {
            continue;
          }
          const hash = createHash('sha256').update(buffer).digest('hex');
          if (seenHashes.has(hash) || exclusions.has(hash)) {
            continue;
          }
          seenHashes.add(hash);
          candidates.push({
            path: entry.path,
            rank: position + 1,
            score,
          });
        } catch {
          // 企微可能已经清理了这张缓存图，忽略即可。
        }
      }

      this.longtuCandidates = candidates;
      return candidates;
    } catch (error) {
      if (!this.longtuIndexWarningShown) {
        console.warn(`无法读取龙图索引：${error.message}`);
        this.longtuIndexWarningShown = true;
      }
      this.longtuCandidates = [];
      return this.longtuCandidates;
    }
  }

  async loadTrustedLongtuCandidates() {
    if (!this.trustedLongtuDirectory) {
      return [];
    }

    const manifestPath = path.join(this.trustedLongtuDirectory, 'manifest.json');
    let manifestEntries = null;
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      this.trustedManifestDetected = true;
      manifestEntries = Array.isArray(manifest.files) ? manifest.files : [];
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.trustedManifestDetected = true;
        console.warn(`无法读取仓库龙图清单：${error.message}`);
        return [];
      }
    }

    const [files, exclusions] = await Promise.all([
      manifestEntries === null
        ? this.scanDirectory(this.trustedLongtuDirectory)
        : Promise.resolve(manifestEntries.map((entry) => ({
          path: typeof entry?.filename === 'string'
            && path.basename(entry.filename) === entry.filename
            ? path.join(this.trustedLongtuDirectory, entry.filename)
            : null,
          sha256: entry?.sha256,
          score: entry?.score,
        }))),
      this.loadLongtuExclusions(),
    ]);
    const seenHashes = new Set();
    const candidates = [];

    const orderedFiles = manifestEntries === null
      ? files.sort().map((filePath) => ({ path: filePath }))
      : files;
    for (const file of orderedFiles) {
      const filePath = file.path;
      if (!filePath) continue;
      try {
        const buffer = await readFile(filePath);
        if (!detectImageExtension(buffer)) {
          continue;
        }
        const hash = createHash('sha256').update(buffer).digest('hex');
        if ((file.sha256 && file.sha256 !== hash) || seenHashes.has(hash) || exclusions.has(hash)) {
          continue;
        }
        seenHashes.add(hash);
        candidates.push({
          path: filePath,
          rank: candidates.length + 1,
          score: Number.isFinite(Number(file.score)) ? Number(file.score) : 0,
        });
      } catch {
        // 仓库素材可能正在同步，暂时读不到时忽略该文件。
      }
    }

    return candidates;
  }

  removeFromIndex(filePath) {
    const index = this.fileIndex.indexOf(filePath);
    if (index >= 0) {
      this.fileIndex.splice(index, 1);
    }
  }

  chooseCandidate(candidates, category) {
    if (candidates.length === 1) {
      return candidates[0];
    }

    const lastPath = this.lastPickedPath.get(category);
    let candidate = candidates[randomInt(candidates.length)];
    for (let attempt = 0; attempt < 5 && candidate.path === lastPath; attempt += 1) {
      candidate = candidates[randomInt(candidates.length)];
    }
    return candidate;
  }

  async readCandidate(candidate, category) {
    const filePath = candidate.path;
    const metadata = await stat(filePath);
    if (metadata.size < 5 || metadata.size > MAX_IMAGE_BYTES) {
      throw new Error('图片大小不符合企微限制');
    }

    const buffer = await readFile(filePath);
    const detectedExtension = detectImageExtension(buffer);
    if (!detectedExtension) {
      throw new Error('无法识别图片格式');
    }

    const parsedPath = path.parse(filePath);
    this.lastPickedPath.set(category, filePath);
    return {
      key: `${filePath}:${metadata.mtimeMs}`,
      filename: `${parsedPath.name}${detectedExtension}`,
      buffer,
      category,
      sourcePath: filePath,
      rank: candidate.rank,
      score: candidate.score,
      extension: detectedExtension,
    };
  }

  async pick(category = 'longtu', options = {}) {
    if (category !== 'longtu') {
      throw new Error('机器人已关闭通用表情包能力，只允许选择龙图');
    }
    const allowedExtensions = options.allowedExtensions
      ? new Set(options.allowedExtensions)
      : null;
    const sourceCandidates = [...await this.loadLongtuCandidates()];

    if (sourceCandidates.length === 0) {
      throw new Error('本地龙图候选集为空，请重新生成索引');
    }

    for (let attempt = 0; attempt < 20 && sourceCandidates.length > 0; attempt += 1) {
      const candidate = this.chooseCandidate(sourceCandidates, category);
      const filePath = candidate.path;
      try {
        const meme = await this.readCandidate(candidate, category);
        if (allowedExtensions && !allowedExtensions.has(meme.extension)) {
          const candidateIndex = sourceCandidates.indexOf(candidate);
          if (candidateIndex >= 0) {
            sourceCandidates.splice(candidateIndex, 1);
          }
          continue;
        }
        return meme;
      } catch (error) {
        console.warn(`跳过无法读取的表情文件：${filePath}`, error.message);
        const candidateIndex = sourceCandidates.indexOf(candidate);
        if (candidateIndex >= 0) {
          sourceCandidates.splice(candidateIndex, 1);
        }
      }
    }

    throw new Error('龙图候选集中没有可用图片');
  }

  async getMediaId(client, meme) {
    const cached = this.mediaCache.get(meme.key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.mediaId;
    }

    const result = await client.uploadMedia(meme.buffer, {
      type: 'image',
      filename: meme.filename,
    });

    this.mediaCache.set(meme.key, {
      mediaId: result.media_id,
      expiresAt: Date.now() + MEDIA_CACHE_TTL_MS,
    });

    return result.media_id;
  }
}
