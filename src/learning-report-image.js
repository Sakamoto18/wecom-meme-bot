// Cache only the most recent report; both recipients receive identical pixels.
export function createLearningReportRenderer(providerUrl, fetchImpl = fetch) {
  let cachedText = '';
  let cachedImage;
  const root = String(providerUrl || '').replace(/\/(?:resolve)?$/u, '');
  return async (text, items = []) => {
    const key = JSON.stringify({ text, items });
    if (!root) throw new Error('学习报告图片未配置网页 provider');
    if (key !== cachedText || !cachedImage) {
      cachedText = key;
      cachedImage = (async () => {
        const response = await fetchImpl(`${root}/learning-report.png`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: key, signal: AbortSignal.timeout(175_000),
        });
        if (!response.ok) throw new Error(`学习报告图片生成失败 HTTP ${response.status}`);
        const image = Buffer.from(await response.arrayBuffer());
        if (!image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('报告未返回 PNG 图片');
        return `base64://${image.toString('base64')}`;
      })();
    }
    const pending = cachedImage;
    try { return await pending; }
    catch (error) { if (cachedImage === pending) cachedImage = null; throw error; }
  };
}
