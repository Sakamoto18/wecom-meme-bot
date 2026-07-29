const LONGTU_WORD = '龙图';

function normalizeContent(content) {
  return String(content ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@\S+\s*/, '')
    .replace(/\s+/g, '')
    .replace(/[，,。.!！?？~～]+$/g, '');
}

export function isLongtuRequest(content) {
  const normalized = normalizeContent(content);
  const suffix = '(?:啊|呀|吧|呗|嘛|呢|看看|谢谢)?';
  const amount = '(?:一|个|张|点|些)?';

  if (!normalized.includes(LONGTU_WORD)) {
    return false;
  }

  const isNegativeRequest = /(?:不要|别|不用|无需|禁止|不许).{0,6}(?:发|来点).{0,12}龙图/.test(normalized);
  if (isNegativeRequest) {
    return false;
  }

  if (normalized.includes('来点') || normalized.includes('发')) {
    return true;
  }

  return new RegExp(`^龙图${suffix}$`).test(normalized)
    || new RegExp(`^(?:请|麻烦)?(?:给我)?(?:来|发|整|搞|甩)${amount}龙图${suffix}$`).test(normalized)
    || new RegExp(`^(?:我)?(?:想要|要)${amount}龙图${suffix}$`).test(normalized);
}
