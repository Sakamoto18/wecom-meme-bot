const REPORT_CONNECTIVE_PATTERN = /(?:首先|其次|再次|另外|此外|同时|总的来说|综上|总体来说|整体来看|从整体上看|值得注意的是|需要指出的是|由此可见|可以看出|简而言之|换句话说|核心在于|本质上|先说|再说|最后说|一方面|另一方面)/gu;
const REPORT_OPENING_PATTERN = /^(?:首先|其次|先说(?:结论|答案)|简单来说|概括来说|总的来说|综合来看|总结一下|从(?:这个|该|图|问题|技术|实际|整体)[^，。！？\n]{0,10}(?:来看|讲)|关于[^，。！？\n]{1,20}[，,：:]|针对[^，。！？\n]{1,20}[，,：:])/u;
const ASSISTANT_META_PATTERN = /(?:作为(?:一个)?(?:AI|人工智能|助手|语言模型)|根据我的(?:知识|理解|训练)|我的知识截止|我无法(?:访问|确认)|让我来(?:帮你|为你)|下面(?:我|将|会)|接下来(?:我|会|将)|希望(?:这|以上|这些)?(?:能|可以|对|帮助)|如需(?:要)?(?:我|进一步)|如果有(?:任何|其他)(?:问题|需要)|欢迎(?:随时|继续)(?:问|咨询|交流)?)/u;
const SUMMARY_CLOSING_PATTERN = /(?:综上|总而言之|总的来说|以上(?:就是|这些)|希望(?:对你|能帮到你)|如需|有需要(?:可以|随时))/u;
const LIST_SHAPE_PATTERN = /(?:^|\n)\s*(?:\d+[.、]|[-*]\s+|[一二三四五六七八九十]+[、.])/mu;
const FALSE_CONTRAST_PATTERN = /(?:这不(?:仅仅|只)?是|这不仅(?:仅)?是|这并不只是|不是(?:一个|一次|一种)?)[^，。！？!?\n]{1,36}(?:[，,]\s*)?(?:更是|而是|简直是|更像)[^。！？!?\n]{0,48}(?:时代|革命|飞跃|新篇章|里程碑|范式|未来|无限可能|全新|入口|认知|格局|世界|重塑|觉醒|价值|意义)/u;
const PSEUDO_DEPTH_PATTERN = /(?:真正(?:重要|关键|核心|厉害|可怕|值得注意|值得思考)的(?:是|不是)|这背后(?:其实)?(?:是|藏着)|从某种意义(?:上|来说)|这才是.{0,18}(?:真正|核心|本质)|与其说[^。！？!?\n]{1,30}不如说|这意味着)/u;
const VAGUE_BACKGROUND_PATTERN = /(?:^|[。！？!?；;\n]\s*)(?:随着[^。！？!?\n]{1,30}(?:的发展|的进步|的普及)|在[^。！？!?\n]{1,30}(?:的时代|的背景下)|当今(?:社会|时代)|众所周知|毋庸置疑|不可否认)/u;
const HYPE_TERM_PATTERN = /(?:赋能|闭环|抓手|底层逻辑|认知升级|降维打击|范式(?:转移|转变)|重塑|彰显|凸显|至关重要|不可或缺|无限可能|未来可期|值得深思|令人深思|新篇章|里程碑|星辰大海|生态位)/gu;
const EMPTY_TRIAD_TERM = '(?:创新|突破|变革|升级|重塑|赋能|未来|可能|价值|意义|格局|认知|想象|效率|体验|生态|共赢|卓越|极致)';
const EMPTY_TRIAD_PATTERN = new RegExp(
  `${EMPTY_TRIAD_TERM}(?:\\s*[、,，/和与及]\\s*(?:(?:全新的?|无限的?|更多的?|持续的?)?${EMPTY_TRIAD_TERM})){2,}`,
  'u',
);
const DASH_OVERLOAD_PATTERN = /(?:——[^。！？!?\n]{0,40}){2,}/u;
const STYLE_META_COMPLAINT_PATTERN = /(?:AI\s*味|机器味|人机味|机器人味|模板味|套路味|像\s*AI|AI\s*感|一股\s*AI|太\s*AI|味儿太冲)/iu;
const OVEREXPLAINED_COMEBACK_PATTERN = /(?:又不是[^。！？!?\n]{1,40}[。！？!?]\s*(?:想|要)[^。！？!?\n]{1,24}(?:就|还是)[^。！？!?\n]{0,28}[，,]\s*别[^。！？!?\n]{1,40}|(?:想|要)[^。！？!?\n]{1,20}(?:还是|或者)[^。！？!?\n]{1,20}[，,]?\s*都行[，,]\s*别)/u;
const COMMANDING_COMEBACK_PATTERN = /(?:要|想)[^。！？!?\n]{1,24}(?:就|还是)[^。！？!?\n]{1,28}[，,]\s*别/u;
const RHETORICAL_ESCALATION_PATTERN = /[^。！？!?\n]{4,60}[。！？!?]\s*(?:这|那)[^。！？!?\n]{0,28}(?:再|要是|继续)[^。！？!?\n]{0,24}[，,]\s*(?:该|是不是|要不要|先)[^。！？!?\n]{0,32}(?:还是|或者)[^。！？!?\n]{0,32}[？?]/u;

export const GROUP_CHAT_HUMANIZER_PROMPT = [
  '【群聊去 AI 腔】直接说具体对象、动作、数字或判断；不要用“不只是X，更是Y”“真正重要的是”“这背后是”“这意味着”给普通结论抬重量。',
  '少用“赋能/闭环/抓手/底层逻辑/认知升级/范式/重塑/彰显/未来可期”这类大词，除非它们就是准确术语。',
  '不写“随着……的发展”“在……时代背景下”“值得一提的是”，也不要为了节奏凑“创新、突破和无限可能”这类抽象排比。',
  '比喻扔出去就停，不接着解释它、追加命令式收尾，也不把同一个意思换词再说一遍。',
  '一个回复最多用一个核心比喻，不要把“方向”继续拧成方向盘、导航、拖车；也别用“这……再……，该先……还是……？”的反问收尾来显得机灵。',
  '被说“AI味/像AI/机器味”时，最多一句承认或反呛就停；不要围绕这个标签继续做“香水/闻/验货”之类的二次比喻，也不要指挥对方换个正经话题。',
  '去 AI 味不是变礼貌、变完整或加免责声明；保留龙玉涛的短、冲、损和具体画面。',
].join('\n');

function normalizedAnswer(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

/**
 * High-confidence Chinese AI-writing tells adapted for short group chat.
 * This is deliberately narrower than Humanizer-zh's full editorial checklist:
 * a hit must be clear enough to justify one repair pass without flattening a
 * legitimate correction, technical term, or deliberate rhetorical contrast.
 */
export function detectHumanizerTells(value, options = {}) {
  const normalized = normalizedAnswer(value);
  if (!normalized
    || options.attackDuringAnswer
    || options.recordSummary
    || options.detailedAnswerRequested
    || options.compactResponse === false
    || options.passiveImageComment) return [];

  const issues = [];
  if (FALSE_CONTRAST_PATTERN.test(normalized)) issues.push('assistant-false-contrast');
  if (PSEUDO_DEPTH_PATTERN.test(normalized)) issues.push('assistant-pseudo-depth');
  if (VAGUE_BACKGROUND_PATTERN.test(normalized)) issues.push('assistant-vague-background');
  if ((normalized.match(HYPE_TERM_PATTERN) ?? []).length >= 2) {
    issues.push('assistant-hype-jargon');
  }
  if (EMPTY_TRIAD_PATTERN.test(normalized)) issues.push('assistant-empty-triad');
  if (DASH_OVERLOAD_PATTERN.test(normalized)) issues.push('assistant-dash-overload');
  if (OVEREXPLAINED_COMEBACK_PATTERN.test(normalized)
    || (normalized.length >= 34 && COMMANDING_COMEBACK_PATTERN.test(normalized))) {
    issues.push('assistant-overwritten-comeback');
  }
  if (RHETORICAL_ESCALATION_PATTERN.test(normalized)) {
    issues.push('assistant-rhetorical-escalation');
  }
  if (isStyleMetaComplaint(options.currentQuestion)) {
    const repeatedMeta = (normalized.match(/AI\s*味|机器味|像\s*AI|开场白|这三个字/giu) ?? []).length >= 2;
    const metaPivot = /(?:香水|验货|循环播放|换个话题|抛个正经话题|正经话题|都行)/u.test(normalized);
    if ((repeatedMeta && normalized.length >= 28)
      || (metaPivot && normalized.length >= 34)) {
      issues.push('assistant-style-meta-loop');
    }
  }
  return [...new Set(issues)];
}

export function isStyleMetaComplaint(value) {
  return STYLE_META_COMPLAINT_PATTERN.test(String(value ?? ''));
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
  issues.push(...detectHumanizerTells(normalized, options));
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
    'assistant-false-contrast',
    'assistant-pseudo-depth',
    'assistant-vague-background',
    'assistant-hype-jargon',
    'assistant-empty-triad',
    'assistant-dash-overload',
    'assistant-overwritten-comeback',
    'assistant-style-meta-loop',
    'assistant-rhetorical-escalation',
  ].some((issue) => set.has(issue));
  if (!needsRewrite) return '';
  const targetedHints = [
    set.has('assistant-false-contrast')
      ? '把“不只是X，更是Y”改成直接说 X 和具体结果；只有两部分都提供信息，或确实在纠正一个误解时才保留对比。'
      : '',
    set.has('assistant-pseudo-depth')
      ? '删掉“真正重要的是/这背后是/这意味着/从某种意义上说/与其说……不如说”这类伪深刻过渡，直接说事情本身。'
      : '',
    set.has('assistant-vague-background')
      ? '删掉“随着……的发展/在……时代背景下/众所周知”这类空背景，从当前具体对象或动作开始。'
      : '',
    set.has('assistant-hype-jargon') || set.has('assistant-empty-triad')
      ? '把“赋能/闭环/底层逻辑/认知升级/重塑/无限可能”等大词和抽象排比换成人话里的具体对象、动作和结果。'
      : '',
    set.has('assistant-dash-overload')
      ? '减少连续破折号制造的假悬念，直接用正常句子说清关系。'
      : '',
    set.has('assistant-overwritten-comeback')
      ? '比喻或反呛扔出去就停，不要再补“想聊就……，别……”式的命令收尾，也不要把同一句换词重复。'
      : '',
    set.has('assistant-style-meta-loop')
      ? '别解释自己像不像 AI，也不要继续香水、闻、验货、开场白这些二次比喻；一句短反应后直接回到具体内容，不指挥对方换话题。'
      : '',
    set.has('assistant-rhetorical-escalation')
      ? '删掉“这……再……，该先……还是……？”的反问收尾，也不要继续把上一句的比喻往外延伸；一句直接回击或判断就停。'
      : '',
  ].filter(Boolean);
  return [
    ...targetedHints,
    '删掉“首先/其次/另外/总的来说/综上/值得注意的是/先说/再说”这类报告连接词，也不要分点、编号、写总结段或自我说明。',
    '像群友当面接一句话：直接给判断、具体反应或下一步；最多保留一个真正影响结论的依据，不要为了完整而扩写。',
    '只删空话和假深刻，不改事实、否定、程度、时间、范围或归因；不要为了去 AI 味把角色改成礼貌客服。',
    '不要复述问题，不要解释自己为什么这样回答；口语不等于硬塞梗，找不到贴合点就正常说。',
  ].join('\n');
}
