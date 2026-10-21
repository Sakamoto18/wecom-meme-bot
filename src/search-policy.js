import {
  shouldSearchCurrentInformation,
  shouldSearchLongtuKnowledge,
  shouldSearchMemeKnowledge,
} from './response-style.js';

// Do not match the substring “联网” inside ordinary style words such as
// “互联网语气”.  A search request is handled by the explicit web-search
// pattern; this rail is only for a concrete factual claim.
const EXPLICIT_FACT_PATTERN = /(?:发生了什么|怎么回事|是否属实|真的吗|核实|事实|证据|原帖|原文|官方|公开信息|数据|统计|哪年|何时|时间线|是谁|哪位|价格|版本|政策|新闻|报道|资料|来源|出处|上网|查一下|搜索一下|查询一下)/u;
// A verification request is stronger than a generic culture lookup. It must
// survive the low-information-image gate so “谁家的 logo”“真的假的” can
// reach fact retrieval even when OCR found little text.
const EXPLICIT_VERIFICATION_PATTERN = /(?:真的假的|真假|是否属实|属实吗|真的吗|假的吧|假的吗|是不是真的|核实|验证|辟谣|谣言|谁家的|哪家的?|哪个品牌|什么品牌|logo|标志|几个月后|三个月后|跨年)/iu;
// Style requests such as “接梗一下”“来点抽象” only choose the reply
// voice.  They must not spend web-search quota.  This pattern is reserved for
// an explicit request to identify, explain, or verify a meme/online term.
const HIGH_CONFIDENCE_CULTURE_PATTERN = /(?:梗.{0,10}(?:意思|含义|来源|出处|由来|怎么火)|(?:什么|啥|这个|这|该)(?:网络)?梗|(?:查|搜|搜索|查询|科普|解释|讲讲|说说).{0,28}(?:梗|黑话|网络用语)|(?:网络用语|网络流行语|流行语|黑话).{0,10}(?:意思|含义|来源|出处|由来))/iu;
const LOW_INFORMATION_IMAGE_PATTERN = /^(?:low_information|low|none)$/i;

function textOf(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

/**
 * Decide whether a turn is allowed to spend external search quota.  This is
 * intentionally a cheap gate: it never calls a model and it never decides
 * what the final reply should say.
 */
export function classifySearchPolicy(options = {}) {
  const content = textOf([options.content, options.currentQuestion].filter(Boolean).join('\n'));
  const attackStyle = options.attackStyle === true;
  const imageSearch = options.imageSearch === true;
  const imagePolicy = textOf(options.imageInformationLevel);
  const lowInformationImage = options.hasImageContext === true
    && LOW_INFORMATION_IMAGE_PATTERN.test(imagePolicy);
  const explicitImageSearch = options.explicitImageSearch === true
    || EXPLICIT_VERIFICATION_PATTERN.test(content);
  const jevCultureLookupNeeded = Number(options.cultureLookupNeeded) || 0;
  const jevLongtuLookupNeeded = Number(options.longtuLookupNeeded) || 0;
  const jevFactLookupNeeded = Number(options.factLookupNeeded) || 0;
  const jevTimeSensitive = Number(options.timeSensitive) || 0;

  const longtuTopic = shouldSearchLongtuKnowledge(content);
  const memeTopic = shouldSearchMemeKnowledge(content);
  const currentFacts = shouldSearchCurrentInformation(content);
  const explicitFacts = EXPLICIT_FACT_PATTERN.test(content);
  const verificationRequested = EXPLICIT_VERIFICATION_PATTERN.test(content)
    || options.verificationRequested === true;
  const highConfidenceCulture = HIGH_CONFIDENCE_CULTURE_PATTERN.test(content);
  const jevCultureEligible = !imageSearch && jevCultureLookupNeeded >= 0.4;
  const cultureEligible = !imageSearch
    && (longtuTopic || memeTopic || highConfidenceCulture || jevCultureEligible);
  // Asking for a meme's source/原帖 is both a cultural lookup and a factual
  // verification request. Keep the two rails independent so one does not
  // silently suppress the other. JEV's own fact/time signals join the union so
  // a plain “现在最新版本是多少” does not depend on the lexical regex alone.
  const factEligible = !imageSearch && (
    currentFacts
    || explicitFacts
    || verificationRequested
    || jevFactLookupNeeded >= 0.45
    || jevTimeSensitive >= 0.5
    || options.unknownConcept === true
  );

  if (attackStyle) {
    return {
      factEligible,
      cultureEligible: false,
      confidence: factEligible ? 'medium' : 'none',
      lowInformationImage,
      reason: 'attack-turn-fact-only',
    };
  }
  if (lowInformationImage && !explicitImageSearch && !verificationRequested) {
    return {
      factEligible: false,
      cultureEligible: false,
      confidence: 'none',
      lowInformationImage: true,
      reason: 'low-information-image',
    };
  }

  if (imageSearch) {
    return {
      factEligible: !lowInformationImage || explicitImageSearch || verificationRequested,
      cultureEligible: false,
      confidence: 'medium',
      lowInformationImage,
      explicitImageSearch,
      verificationRequested,
      reason: lowInformationImage
        ? (explicitImageSearch || verificationRequested
          ? 'explicit-low-information-image'
          : 'low-information-image')
        : 'explicit-image-clues',
    };
  }

  const confidence = longtuTopic || memeTopic || jevLongtuLookupNeeded >= 0.7
    ? 'high'
    : (highConfidenceCulture ? 'high' : (factEligible ? 'medium' : 'none'));
  return {
    factEligible,
    cultureEligible,
    confidence,
    lowInformationImage,
    reason: factEligible && cultureEligible
      ? 'fact-and-culture'
      : (factEligible ? 'fact-intent' : (cultureEligible ? 'culture-intent' : 'no-search-intent')),
    explicitImageSearch,
    verificationRequested,
  };
}

export function isExplicitVerificationRequest(content = '') {
  return EXPLICIT_VERIFICATION_PATTERN.test(String(content ?? ''));
}

export function isHighConfidenceCulturePolicy(policy = {}) {
  return policy.cultureEligible === true && policy.confidence === 'high';
}
