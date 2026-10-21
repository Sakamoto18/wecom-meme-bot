const REPORT_CONNECTIVE_PATTERN = /(?:首先|其次|再次|另外|此外|同时|总的来说|综上|总体来说|整体来看|从整体上看|值得注意的是|需要指出的是|由此可见|可以看出|简而言之|换句话说|核心在于|本质上|先说|再说|最后说|一方面|另一方面)/gu;
const REPORT_OPENING_PATTERN = /^(?:首先|其次|先说(?:结论|答案)|简单来说|概括来说|总的来说|综合来看|总结一下|从(?:这个|该|图|问题|技术|实际|整体)[^，。！？\n]{0,10}(?:来看|讲)|关于[^，。！？\n]{1,20}[，,：:]|针对[^，。！？\n]{1,20}[，,：:])/u;
const ASSISTANT_META_PATTERN = /(?:作为(?:一个)?(?:AI|人工智能|助手|语言模型)|根据我的(?:知识|理解|训练)|我的知识截止|我无法(?:访问|确认)|让我来(?:帮你|为你)|下面(?:我|将|会)|接下来(?:我|会|将)|希望(?:这|以上|这些)?(?:能|可以|对|帮助)|如需(?:要)?(?:我|进一步)|如果有(?:任何|其他)(?:问题|需要)|欢迎(?:随时|继续)(?:问|咨询|交流)?)/u;
const SUMMARY_CLOSING_PATTERN = /(?:综上|总而言之|总的来说|以上(?:就是|这些)|希望(?:对你|能帮到你)|如需|有需要(?:可以|随时))/u;
const LIST_SHAPE_PATTERN = /(?:^|\n)\s*(?:\d+[.、]|[-*]\s+|[一二三四五六七八九十]+[、.])/mu;

function normalizedAnswer(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

/**
 * Detect the most common "assistant report" tells without trying to judge the
 * actual answer. This is intentionally conservative: it runs only for compact
 * chat replies, because a user-requested article or a record summary may
 * legitimately use structure.
 */
export function detectAssistantReportStyle(value, options = {}) {
  const normalized = normalizedAnswer(value);
  if (!normalized
    || options.recordSummary
    || options.detailedAnswerRequested
    || options.compactResponse === false
    || options.passiveImageComment) return [];

  const issues = [];
  const connectives = normalized.match(REPORT_CONNECTIVE_PATTERN) ?? [];
  if (connectives.length >= 3
    || (connectives.length >= 2 && normalized.length >= 120)) {
    issues.push('assistant-connective-overload');
  }
  if (REPORT_OPENING_PATTERN.test(normalized)) issues.push('assistant-report-opening');
  if (ASSISTANT_META_PATTERN.test(normalized)) issues.push('assistant-meta-voice');
  if (normalized.length >= 40
    && (SUMMARY_CLOSING_PATTERN.test(normalized)
      || /(?:总的来说|综上|总而言之).{0,12}$/u.test(normalized))) {
    issues.push('assistant-summary-closing');
  }
  if (LIST_SHAPE_PATTERN.test(normalized)
    || (normalized.match(/；/gu) ?? []).length >= 2) {
    issues.push('report-list-shape');
  }
  return issues;
}

export function buildNaturalnessRewriteHint(issues = []) {
  const set = new Set(Array.isArray(issues) ? issues : []);
  const needsRewrite = [
    'assistant-connective-overload',
    'assistant-report-opening',
    'assistant-meta-voice',
    'assistant-summary-closing',
    'report-list-shape',
  ].some((issue) => set.has(issue));
  if (!needsRewrite) return '';
  return [
    '删掉“首先/其次/另外/总的来说/综上/值得注意的是/先说/再说”这类报告连接词，也不要分点、编号、写总结段或自我说明。',
    '像群友当面接一句话：直接给判断、具体反应或下一步；最多保留一个真正影响结论的依据，不要为了完整而扩写。',
    '不要复述问题，不要解释自己为什么这样回答；口语不等于硬塞梗，找不到贴合点就正常说。',
  ].join('\n');
}
