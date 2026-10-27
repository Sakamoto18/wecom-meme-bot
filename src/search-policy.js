import {
  shouldSearchCurrentInformation,
  shouldSearchLongtuKnowledge,
  shouldSearchMemeKnowledge,
} from './response-style.js';

// Do not match the substring “联网” inside ordinary style words such as
// “互联网语气”.  A search request is handled by the explicit web-search
// pattern; this rail is only for a concrete factual claim.
const EXPLICIT_FACT_PATTERN = /(?:发生了什么|什么情况|怎么回事|咋回事|没看懂|看不懂|是否属实|真的吗|核实|事实|证据|原帖|原文|官方|公开信息|数据|统计|哪年|何时|时间线|是谁|哪位|价格|版本|政策|新闻|报道|资料|来源|出处|上网|查一下|搜索一下|查询一下)/u;
// 时效性事件不能只靠“新闻/最新/最近”这几个词。群友经常说“昨天的
// PHP 漏洞”“刚才那个事故”，时间词和事件词分开出现，但指的就是一条
// 需要外部核实的现实信息。
const RECENT_TIME_PATTERN = /(?:昨天|昨日|前天|今天|今日|刚刚|刚才|这两天|这几天|这周|本周|上周|最近|近期|最新)/iu;
const PUBLIC_EVENT_PATTERN = /(?:漏洞|CVE-\d{4}-\d+|RCE|0day|零日|补丁|安全事件|数据泄露|泄露|事故|通报|公告|发布会|判决|处罚|政策|热搜|报道|新闻|赛果|比分|票房|股价|汇率)/iu;
// 群友经常把“漏洞”省掉，只说“最近 PHP 的事情”“这两天日本 IT 出事”。
// 只要时间词和明确的技术/产品主体同时出现，并带有影响或异常语境，就不能
// 因为缺少一个“漏洞”二字把整轮降成闲聊。
const NAMED_TECH_TOPIC_PATTERN = /(?:PHP2Shell|PHP|WordPress|Drupal|Joomla|OpenSSL|Log4j|Spring|Tomcat|Nginx|Apache|MySQL|PostgreSQL|Redis|Linux|Windows|macOS|Android|iOS|Java|JavaScript|Node(?:\.js)?|Python|Ruby|Rust|Docker|Kubernetes|K8s|GitLab|Jenkins|Exchange|Chrome|Firefox|Safari|AWS|Azure|Cloudflare|OpenAI|DeepSeek|Qwen)/iu;
const RECENT_NAMED_EVENT_CONTEXT_PATTERN = /(?:事情|大事|新闻|报道|影响(?:最大)?|出事|崩|挂|宕机|故障|维护|攻击|漏洞|补丁|安全|不知道|没听说|怎么回事|什么情况|进展|动态)/iu;
// “这个漏洞和图中的梗有什么关系”同时包含现实事件和梗。它既不是纯
// 文化查询，也不是泛泛的“什么意思”，事实链必须一起打开。
const MEME_EVENT_LINK_PATTERN = /(?:漏洞|CVE-\d{4}-\d+|RCE|0day|零日|补丁|安全事件|数据泄露|事故|通报|公告|发布会|判决|处罚|政策|热搜|报道|新闻).{0,24}(?:梗|图|图片|截图|段子)|(?:梗|图|图片|截图|段子).{0,24}(?:漏洞|CVE-\d{4}-\d+|RCE|0day|零日|补丁|安全事件|数据泄露|事故|通报|公告|发布会|判决|处罚|政策|热搜|报道|新闻)/iu;
const TECHNICAL_RULE_PATTERN = /(?:私钥|密钥|助记词|钱包|算法|协议|编码|哈希|签名|校验|合法|取值范围|格式|定义)/iu;
const TECHNICAL_RULE_INTENT_PATTERN = /(?:为什么|怎么|是不是|能不能|可不可以|合法|范围|完整|格式|定义|原理|意思|算不算|对不对)/iu;
// A verification request is stronger than a generic culture lookup. It must
// survive the low-information-image gate so “谁家的 logo”“真的假的” can
// reach fact retrieval even when OCR found little text.
const EXPLICIT_VERIFICATION_PATTERN = /(?:真的假的|真假|是否属实|属实吗|真的吗|假的吧|假的吗|是不是真的|核实|验证|辟谣|谣言|谁家的|哪家的?|哪个品牌|什么品牌|logo|标志|(?:\d+|[一二两三四五六七八九十几]+)\s*(?:天|日)后|过几天|下周|本周末|月底|下个月|几个月后|三个月后|跨年)/iu;
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
  const unknownConcept = options.unknownConcept === true;
  const semanticImageSearch = options.semanticImageSearch === true;
  const plannerSearch = options.plannerPlan?.search && typeof options.plannerPlan.search === 'object'
    ? options.plannerPlan.search : {};
  const plannerFactRequested = plannerSearch.factNeeded === true;
  const plannerCultureRequested = plannerSearch.cultureNeeded === true;
  const plannerFreshness = ['current', 'general', 'none'].includes(plannerSearch.freshness)
    ? plannerSearch.freshness : 'none';

  const longtuTopic = shouldSearchLongtuKnowledge(content);
  const memeTopic = shouldSearchMemeKnowledge(content);
  const currentFacts = shouldSearchCurrentInformation(content);
  const explicitFacts = EXPLICIT_FACT_PATTERN.test(content);
  const recentPublicEvent = RECENT_TIME_PATTERN.test(content)
    && PUBLIC_EVENT_PATTERN.test(content);
  const recentNamedEvent = RECENT_TIME_PATTERN.test(content)
    && NAMED_TECH_TOPIC_PATTERN.test(content)
    && RECENT_NAMED_EVENT_CONTEXT_PATTERN.test(content);
  const memeEventLink = MEME_EVENT_LINK_PATTERN.test(content);
  const technicalRuleRequested = TECHNICAL_RULE_PATTERN.test(content)
    && TECHNICAL_RULE_INTENT_PATTERN.test(content);
  const verificationRequested = EXPLICIT_VERIFICATION_PATTERN.test(content)
    || options.verificationRequested === true;
  const concreteTextFact = plannerFactRequested
    || recentPublicEvent || recentNamedEvent || memeEventLink || technicalRuleRequested;
  const recentEventRequested = recentPublicEvent || recentNamedEvent;
  const highConfidenceCulture = HIGH_CONFIDENCE_CULTURE_PATTERN.test(content);
  const jevCultureEligible = !imageSearch && jevCultureLookupNeeded >= 0.4;
  const cultureEligible = semanticImageSearch
    || (!imageSearch
      && (plannerCultureRequested || longtuTopic || memeTopic || highConfidenceCulture || jevCultureEligible || unknownConcept));
  // Asking for a meme's source/原帖 is both a cultural lookup and a factual
  // verification request. Keep the two rails independent so one does not
  // silently suppress the other. JEV's own fact/time signals join the union so
  // a plain “现在最新版本是多少” does not depend on the lexical regex alone.
  const textFactEligible = (
    currentFacts
    || plannerFactRequested
    || explicitFacts
    || recentPublicEvent
    || recentNamedEvent
    || memeEventLink
    || technicalRuleRequested
    || verificationRequested
    || jevFactLookupNeeded >= 0.45
    || jevTimeSensitive >= 0.5
    // A bare policy call may only have the unknown-concept flag; in the full
    // reply route a strong culture score owns this lookup and must stay on the
    // wiki/culture rail rather than launching a second generic fact search.
    || (unknownConcept && jevCultureLookupNeeded < 0.4 && jevLongtuLookupNeeded < 0.4)
  );
  const factEligible = !imageSearch && textFactEligible;

  if (attackStyle) {
    return {
      factEligible,
      cultureEligible: false,
      confidence: factEligible ? 'medium' : 'none',
      lowInformationImage,
      textFactEligible,
      recentEventRequested,
      plannerFactRequested,
      plannerCultureRequested,
      plannerFreshness,
      reason: 'attack-turn-fact-only',
    };
  }
  if (lowInformationImage && !explicitImageSearch && !verificationRequested && !semanticImageSearch) {
    if (concreteTextFact) {
      return {
        factEligible: true,
        cultureEligible: false,
        confidence: 'medium',
        lowInformationImage: true,
        textFactEligible,
        recentEventRequested,
        plannerFactRequested,
        plannerCultureRequested,
        plannerFreshness,
        semanticImageSearch,
        reason: 'concrete-text-fact',
      };
    }
    return {
      factEligible: false,
      cultureEligible: false,
      confidence: 'none',
      lowInformationImage: true,
      textFactEligible,
      recentEventRequested,
      plannerFactRequested,
      plannerCultureRequested,
      plannerFreshness,
      semanticImageSearch,
      reason: 'low-information-image',
    };
  }

  if (imageSearch) {
    return {
      factEligible: !lowInformationImage
        || explicitImageSearch
        || verificationRequested
        || plannerFactRequested
        || (semanticImageSearch && concreteTextFact)
        || concreteTextFact,
      textFactEligible,
      recentEventRequested,
      cultureEligible: semanticImageSearch || plannerCultureRequested,
      plannerFactRequested,
      plannerCultureRequested,
      plannerFreshness,
      confidence: 'medium',
      lowInformationImage,
      explicitImageSearch,
      verificationRequested,
      semanticImageSearch,
      reason: lowInformationImage
        ? (explicitImageSearch || verificationRequested || semanticImageSearch || concreteTextFact
          ? 'explicit-low-information-image'
          : 'low-information-image')
        : 'explicit-image-clues',
    };
  }

  const confidence = longtuTopic || memeTopic || jevLongtuLookupNeeded >= 0.7 || unknownConcept
    ? 'high'
    : (highConfidenceCulture ? 'high' : (factEligible ? 'medium' : 'none'));
  return {
    factEligible,
    textFactEligible,
    recentEventRequested,
    plannerFactRequested,
    plannerCultureRequested,
    plannerFreshness,
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
