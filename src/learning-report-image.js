// Full web-learning reports use the same image renderer as daily reports.
// Short progress/help responses stay text; never retry a QQ send here.
export async function renderWebLearningResponse(result, render) {
  if (result?.mode !== 'web-meme-learning-report') return result;
  const report = result.messages?.find(row => row.type === 'text'
    && String(row.text).startsWith('联网学梗报告：'));
  if (!report) return result;
  try {
    const image = await render(report.text);
    if (!/^base64:\/\/iVBOR/u.test(image)) throw new Error('Invalid report PNG');
    return { ...result, learning_report_term: report.text.split('\n')[0].slice('联网学梗报告：'.length), messages: [{ type: 'image', base64: image.slice('base64://'.length) }] };
  } catch {
    return { ...result, messages: [{ type: 'text',
      text: '学习结果已生成，但报告图片暂时生成失败。请用 /learn-status 查看结果，稍后用 /learn-report 重取。' }] };
  }
}

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
