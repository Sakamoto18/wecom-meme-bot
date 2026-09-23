export function requestsSourceDisplay(question) {
  const text = String(question ?? '');
  if (/(?:不要|不用|别|无需|不必).{0,8}(?:来源|出处|引用|链接|参考)/u.test(text)) return false;
  return /(?:来源|出处|原文|原帖|参考文献|参考资料|引用链接|参考链接|证据|谁说的|哪[里儿]看到|从哪.{0,4}来|(?:给|发|贴|提供).{0,8}链接)/u.test(text);
}

export function sourceDisplayPrompt(question) {
  return requestsSourceDisplay(question)
    ? '本轮用户明确询问来源或原文：只列必要且真实存在的出处/链接，证据不足照实说，不编造。'
    : '本轮没有要求展示来源：联网证据只用于后台核实，最终直接说结论，禁止自动添加媒体名括号尾注、来源标签、参考文献列表或引用链接。日期、数字、适用条件和不确定性必须保留；正文讨论的机构/人物不是引用尾注，不应删掉。';
}

// Suppress citation decorations, never ordinary parenthetical facts. A bare
// publisher must be present in retrieved evidence before treating it as a cite.
export function suppressUnrequestedSourceNotes(answer, question, searchResult = {}) {
  if (requestsSourceDisplay(question)) return String(answer ?? '');
  const evidence = [searchResult.context, ...(searchResult.results ?? []).map(result =>
    [result.title, result.url, result.source, result.publisher].filter(Boolean).join(' '))].filter(Boolean).join('\n');
  return String(answer ?? '').replace(/[（(]([^()（）\n]{1,100})[）)]/gu, (whole, body) => {
    const label = body.trim();
    if (/^(?:来源|出处|参考(?:来源|资料)?|source|via)\s*[:：]/iu.test(label)
      || /^https?:\/\/\S+$/iu.test(label)) return '';
    const publisher = /^[\p{L}·]{2,25}(?:报|网|新闻|通讯社|百科)$/u.test(label)
      || /^(?:[a-z\d-]+\.)+[a-z]{2,}$/iu.test(label);
    return publisher && evidence.includes(label) ? '' : whole;
  }).trim();
}
