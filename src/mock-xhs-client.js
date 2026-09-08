import { randomBytes, createHmac } from 'node:crypto';

function noteIdFromUrl(value) {
  const url = new URL(value);
  const match = url.pathname.match(/\/(?:explore|discovery\/item)\/([^/]+)/u);
  if (!match) throw new Error('无法从 Mock 分享地址提取笔记 ID');
  return match[1];
}

export async function resolveMockXhsShare(input, {
  secret,
  deviceId = 'mock-device-001',
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  if (!secret) throw new Error('Mock XHS secret is required');
  const redirect = await fetchImpl(input, { redirect: 'follow' });
  if (!redirect.ok) throw new Error(`短链跳转失败：HTTP ${redirect.status}`);
  const finalUrl = redirect.url || input;
  const noteId = noteIdFromUrl(finalUrl);
  const timestamp = now();
  const nonce = randomBytes(12).toString('hex');
  const signature = createHmac('sha256', secret)
    .update(`${noteId}.${timestamp}.${nonce}`)
    .digest('hex');
  const detailUrl = new URL(`/api/notes/${noteId}`, finalUrl);
  const detail = await fetchImpl(detailUrl, {
    headers: {
      'x-mock-device-id': deviceId,
      'x-mock-timestamp': String(timestamp),
      'x-mock-nonce': nonce,
      'x-mock-signature': signature,
    },
  });
  if (!detail.ok) throw new Error(`Mock 笔记详情失败：HTTP ${detail.status}`);
  const body = await detail.json();
  const videos = Array.isArray(body?.data?.videos) ? body.data.videos : [];
  const video = videos.at(-1);
  if (!video?.url) throw new Error('Mock 笔记没有视频流');
  return {
    noteId,
    title: body.data.title || '',
    coverUrl: body.data.image || '',
    videoUrl: video.url,
    quality: video.quality || '',
  };
}
