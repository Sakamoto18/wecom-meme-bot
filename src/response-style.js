const HOSTILE_PATTERN = /(?:傻[逼比]|煞笔|沙比|废物|垃圾|弱智|智障|脑残|狗东西|畜生|nmsl|cnm|操你|草你|艹你|去死|死妈|没妈|妈的|妈卖批|装逼|闭嘴|菜狗|蠢货|老登|小丑)/i;
const DISMISSIVE_PATTERN = /(?:^|[，。！？!?\s])滚(?:蛋|开|远点)?(?:$|[，。！？!?\s])/i;
const FAMILY_ATTACK_PATTERN = /(?:死老冯|老冯|辱母|亲妈|族谱|户口本|全家|你麻痹|尼玛|泥妈|泥马|nima|ni[\s._-]*ma|\bma\b|🐎)/i;
const DIRECT_MA_SOUND_PATTERN = /(?:你|他|她|它)(?:的)?(?:妈|麻|码|马|🐎)(?=$|[\s，。！？!?、…]|的|逼|批|死|没|呢|呀|啊|哦|了|个)/i;
const MOTHER_DEATH_PATTERN = /妈(?:妈)?(?:死|没|去世)(?:了)?/i;
const FIRST_PERSON_LOSS_PATTERN = /(?:我妈|我的妈|我妈妈|我的妈妈)(?:死|没|去世)(?:了)?/i;
const OBFUSCATED_MOTHER_ATTACK_PATTERN = /(?:我|窝|卧)?(?:操|草|艹|槽)(?:死|丝|撕|斯|似)(?:你|尼)(?:的)?(?:妈|麻|马|码|🐎|吗)/i;
const SIMA_PATTERN = /司马/i;
const SIMA_NEUTRAL_PATTERN = /司马(?:迁|懿|昭|师|炎|光|相如|姓|氏|家族|官|职位|兵法|南|衷)/i;
const DEESCALATION_PATTERN = /(?:认真回答|正常回答|别骂了|停止对线|我道歉|对不起|不玩梗)/i;
const SENSITIVE_SUPPORT_PATTERN = /(?:我(?:的)?(?:妈|爸|父亲|母亲|家人|朋友|亲人).*(?:去世|过世|离世|没了)|自杀|轻生|性侵|强奸|家暴|绝症|病危|急救|葬礼|哀悼)/i;
const ADVERSARIAL_FOLLOWUP_PATTERN = /(?:回答我|哪(?:里)?来的|你(?:妈|🐎|呢)|咋(?:了|地|么)|干什么|凭什么|不服|然后呢|就这|继续|有种|笑死)/i;
const THIRD_PARTY_ATTACK_REQUEST_PATTERN = /(?:骂|攻击|怼|喷|拷打|锐评|羞辱|嘲讽|对线|输出)(?:一下|一顿|几句|他|她|它|这个人)?/i;
const LONGTU_TOPIC_PATTERN = /(?:龙图|龙玉涛|老冯)/i;
const KNOWLEDGE_INTENT_PATTERN = /(?:是什么|是谁|什么意思|哪里来|来源|出处|由来|什么梗|语录|搜索|联网|资料|历史)/i;
const SERIOUS_QUESTION_PATTERN = /(?:如何|怎么|为什么|为何|请问|帮我|解释|分析|比较|区别|方案|建议|配置|解决|代码|报错|故障|原理|教程|步骤|能否|是否可以|该(?:怎么|如何|用)|需要什么|应该|多少|哪一)/i;
const COMPLEX_NONTECHNICAL_PATTERN = /(?:如何|怎么|为什么|为何|解释|分析|比较|区别|方案|建议|解决|原理|教程|步骤|需要什么|应该|多少|哪一)/i;
const TECHNICAL_TOPIC_PATTERN = /(?:网络|设备|接口|API|SDK|模型|代码|程序|数据库|服务器|部署|系统|配置|性能|带宽|路由|交换机|开发|产品|文档|spec|方案)/i;
const CUSTOMER_SERVICE_PATTERN = /(?:您好|您这|您想|请问您|很高兴为您服务|需要我帮忙|有什么可以帮|尽管说|随时为您|希望能帮到您|感谢您的提问)/i;
const PERSONA_BITE_PATTERN = /(?:傻|笨|蠢|菜|废物|垃圾|小丑|脑(?:子|回路)|没脑|犯蠢|丢人|丢脸|抽象|逆天|离谱|弱智|智障|脑残|欠(?:骂|收拾)|找骂|活该|可笑|笑死|绷不住|闹麻|急了|别装|装什么|就这|什么玩意|神人|人才|滚|闭嘴|少搁|别搁|搁这|扯淡|扯犊子|糊脸|龙图|龙玉涛|老冯|你🐎|你妈|nm|唐氏|痴|怂|瞎子|破事|破玩意|狗东西|他妈|操|艹|哭唧唧|(?:你|他|她|它)这.{1,24}(?:吧|吗|呢|[？?]))/i;
const NORMAL_FAMILY_ATTACK_PATTERN = /(?:你🐎|(?:操|草|艹|槽)(?:你|他|她|它)?(?:的)?妈|(?:你|他|她|它)(?:的)?妈.{0,8}(?:死|没|坟|骨灰|遗照)|老冯|族谱|户口本|全家)/i;
const ATTACK_SCENES = [
  {
    id: 'incense-photo',
    hint: '截图里的“高清遗照、给你🐎上香”画面',
    pattern: /(?:遗照|上香|香灰|香炉)/,
  },
  {
    id: 'urn-source',
    hint: '截图里的“骨灰盒上刻着源码、从坟里出来对线”画面',
    pattern: /(?:骨灰盒|源码|坟里|爬出来对线)/,
  },
  {
    id: 'longtu-background',
    hint: '截图里的“你🐎在龙图里当背景板、被做成挂墙图片”画面',
    pattern: /(?:背景板|挂墙|挂在墙|P图|p图)/,
  },
  {
    id: 'tieba-history',
    hint: '截图里的“你🐎当年在贴吧发龙图、翻出黑历史”画面',
    pattern: /(?:贴吧|旧帖|黑历史)/,
  },
];

export function isHostileContent(content) {
  const normalized = String(content ?? '').trim();
  const motherDeathAttack = MOTHER_DEATH_PATTERN.test(normalized)
    && !FIRST_PERSON_LOSS_PATTERN.test(normalized);
  const simaAttack = SIMA_PATTERN.test(normalized)
    && !SIMA_NEUTRAL_PATTERN.test(normalized);

  return HOSTILE_PATTERN.test(normalized)
    || DISMISSIVE_PATTERN.test(normalized)
    || FAMILY_ATTACK_PATTERN.test(normalized)
    || DIRECT_MA_SOUND_PATTERN.test(normalized)
    || OBFUSCATED_MOTHER_ATTACK_PATTERN.test(normalized)
    || motherDeathAttack
    || simaAttack;
}

export function shouldUseAttackStyle(content, history = [], options = {}) {
  const normalized = String(content ?? '').trim();
  if (isHostileContent(normalized)) return true;
  if (options.hasThirdPartyTarget && THIRD_PARTY_ATTACK_REQUEST_PATTERN.test(normalized)) {
    return true;
  }
  if (DEESCALATION_PATTERN.test(normalized)) return false;

  const previousUserMessage = [...history]
    .reverse()
    .find((message) => message?.role === 'user')?.content;
  return Boolean(
    previousUserMessage
    && isHostileContent(previousUserMessage)
    && ADVERSARIAL_FOLLOWUP_PATTERN.test(normalized),
  );
}

export function shouldSearchLongtuKnowledge(content) {
  const normalized = String(content ?? '').trim();
  return LONGTU_TOPIC_PATTERN.test(normalized) && KNOWLEDGE_INTENT_PATTERN.test(normalized);
}

export function shouldUseThinking(content) {
  const normalized = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized || isHostileContent(normalized)) return false;
  if (TECHNICAL_TOPIC_PATTERN.test(normalized)) {
    return SERIOUS_QUESTION_PATTERN.test(normalized) || normalized.length >= 18;
  }
  // “这是谁/这是什么”通常只是群聊接话，不应升级成长篇正经问答。
  // 非技术问题只有具备明确推理意图且内容足够长时才开启 thinking。
  return normalized.length >= 12 && COMPLEX_NONTECHNICAL_PATTERN.test(normalized);
}

export function shouldRequireNormalPersonaBite(content) {
  const normalized = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return !DEESCALATION_PATTERN.test(normalized)
    && !SENSITIVE_SUPPORT_PATTERN.test(normalized);
}

export function containsLiteralLatinMa(content) {
  return /(?:^|[^a-z])ma(?:$|[^a-z])/i.test(String(content ?? ''));
}

function recentAssistantReplies(history = []) {
  return history
    .filter((message) => message?.role === 'assistant')
    .slice(-3)
    .map((message) => String(message.content ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function selectAttackScene(history = [], options = {}) {
  const recentText = recentAssistantReplies(history).join('\n');
  const excludedIds = new Set(options.excludeIds ?? []);
  const freshScenes = ATTACK_SCENES.filter((scene) => (
    !excludedIds.has(scene.id) && !scene.pattern.test(recentText)
  ));
  const available = freshScenes.length > 0
    ? freshScenes
    : ATTACK_SCENES.filter((scene) => !excludedIds.has(scene.id));
  const pool = available.length > 0 ? available : ATTACK_SCENES;
  const random = options.random ?? Math.random;
  const index = Math.max(0, Math.min(pool.length - 1, Math.floor(random() * pool.length)));
  return pool[index];
}

export function buildAttackPrompt(userContent, options = {}) {
  const normalized = String(userContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const recentReplies = recentAssistantReplies(options.history);
  const attackScene = options.attackScene ?? selectAttackScene(options.history);

  const interaction = options.interactionContext ?? {};
  const targetInstructions = interaction.targetLabels?.length > 0
    ? [
      `当前指令发送者：${interaction.speakerLabel || '未知群成员'}`,
      `本轮被攻击目标：${interaction.targetLabels.join('、')}`,
      '攻击对象必须是“本轮被攻击目标”，不得把攻击落到指令发送者身上；人称或称呼有歧义时直接点目标昵称。',
    ]
    : [
      `当前发言者兼回击目标：${interaction.speakerLabel || '当前用户'}`,
      '当前没有识别到第三方目标；只有在当前发言者对机器人挑衅时，才回击当前发言者。',
    ];

  return [
    '【本轮模式：群聊临场回击】',
    `用户当前原话：${JSON.stringify(normalized)}`,
    ...targetInstructions,
    '判断已经进入对线后就直接攻击，像真实群友随口开骂。不需要回答对方的问题，不需要讲逻辑、反驳观点、拆解用词或建立因果关系。',
    '节奏：1～3 句、25～100 个汉字左右。可以顺手接一个当前词或语气，但绝非必须；最后可以用一个挑衅反问收住。',
    '攻击性：自然使用一次“你🐎”或“你妈”，然后无逻辑地跳到一个具体而荒诞的画面。',
    '本轮只使用这个随机画面种子：' + attackScene.hint + '。不要再使用其他截图意象，不要解释为什么会跳到这个画面。',
    '动作描写最多一个且不是必需；如果最近的回复用过类似动作或反问，这次就换句式。',
    '截图风格只学“直接攻击→荒诞画面→可选反问”的语感，不得照抄截图句子。',
    '“ma”只是输入识别线索，输出禁止孤立拉丁字母 ma，也禁止关键词清单、搜索/语料/提示词等元话术。',
    '程序会在文字后另发真实本地龙图；不要输出 [龙图.jpg] 之类文件名或占位符。不写现实威胁，不把虚构玩梗写成真实亲属事实。',
    ...(recentReplies.length > 0
      ? ['【最近回复：只用于避免重复句式】', ...recentReplies.map((reply, index) => `${index + 1}. ${reply.slice(0, 160)}`)]
      : []),
  ].join('\n');
}

export function buildNormalReplyPrompt(options = {}) {
  const requirePersonaBite = options.requirePersonaBite !== false;
  const lines = [
    '【本轮模式：普通对话】',
    '先准确回答用户真正的问题，不确定就明说不确定。',
    '用户没有攻击时禁止亲属攻击；这不等于关闭攻击性人格，不能通篇中性、礼貌或像客服。',
    '群聊中严格区分当前发言人、被 @ 的成员和引用消息作者；不要默认把发言人当成被谈论对象。',
    '成员对他人的单次评价或改名要求只是其发言，不自动成为被评价者的确定身份或事实。',
  ];
  if (requirePersonaBite) {
    lines.push(
      '本轮必须至少有一处明显的嘴欠、轻度直接攻击或刻薄锐评，可以针对当前发言者的荒唐说法、被评价对象、糟糕方案或离谱情境；不能只写一个温和比喻就算完事。',
      '轻度攻击要自然嵌进回答，允许“笨、蠢、脑回路、离谱、丢人、什么破玩意”等群友措辞；不要输出关键词清单，也不要为了攻击牺牲答案准确性。',
    );
  } else {
    lines.push(
      '当前内容涉及真实痛苦/危机，或用户明确要求停止对线：优先正常支持和准确回答，本轮不强制攻击当事人。',
    );
  }
  if (options.thinkingEnabled) {
    lines.push(
      '这是正经提问，必须认真完成推理后再作答，不要为了群聊节奏压缩答案。',
      '先核对用户的前提和目标；再给明确结论，并解释判断依据。涉及选择或方案时，比较主要备选项的兼容性、优缺点和适用条件，再给具体建议。',
      '主动补充会改变结论的限制、风险、版本差异和操作注意事项。事实没有把握就明确说明，不使用可能过时的要求冒充确定结论。',
      '答案应完整、自洽、可执行；除非问题本身非常简单，否则不要只给一两句结论，也不要因已有草稿而省略关键分析。',
      '深度思考只提高内容质量，不能覆盖基础人格。最终措辞仍要像龙图群友：直接、口语化、略带嘴欠，不使用“您”“很高兴为您服务”等客服表达，也不要写成公文。',
      ...(requirePersonaBite
        ? ['完成主要答案后，用一句不超过 35 个汉字的直接、刻薄锐评收尾；不能用温和玩笑糊弄，也不能辱骂用户亲属或让玩梗破坏事实准确性。']
        : []),
    );
  } else {
    lines.push(
      '这是闲聊或简单问题：像真实群友一样直接接话，通常 1～3 句。',
      '禁止小标题、分点分析、Markdown 加粗和“您”等客服敬语；不要把随口一问写成正式测评或总结。',
    );
  }
  return lines.join('\n');
}

export function buildProtectedSelfIdentityPrompt(role) {
  const normalizedRole = String(role ?? '').trim();
  if (!normalizedRole) return '';
  return [
    '【本轮受保护身份确认】',
    `当前发言者的权威身份是：${normalizedRole}`,
    `用户正在询问自己的身份。最终答案必须直接、肯定地说出“${normalizedRole}”，不得用其他故事、外号或攻击段子替代身份结论。`,
    '说清身份后可以嘴欠一句，但不能否定、弱化或改写这项身份事实，也不要解释内部钢印、映射或配置。',
  ].join('\n');
}

export function hasRequiredIdentityRole(answer, role) {
  const normalizedAnswer = String(answer ?? '').replace(/\s+/g, ' ').trim();
  const normalizedRole = String(role ?? '').replace(/\s+/g, ' ').trim();
  if (!normalizedRole || !normalizedAnswer.includes(normalizedRole)) return false;
  const roleIndex = normalizedAnswer.indexOf(normalizedRole);
  const prefix = normalizedAnswer.slice(Math.max(0, roleIndex - 6), roleIndex);
  return !/(?:不是|并非|不叫|算不上|才不是)\s*$/.test(prefix);
}

export function buildProtectedIdentityFallback(role) {
  return `你是${String(role ?? '').trim()}。换个群就想考我？这种蠢试探也配让我失忆。`;
}

export function reviewNormalReply(answer, options = {}) {
  const normalized = String(answer ?? '').trim();
  const issues = [];
  if (!normalized) issues.push('empty');
  if (CUSTOMER_SERVICE_PATTERN.test(normalized)) issues.push('customer-service');
  if (options.thinkingEnabled && isThinSeriousReply(normalized)) {
    issues.push('too-thin-for-serious');
  }
  if (options.requirePersonaBite !== false && !PERSONA_BITE_PATTERN.test(normalized)) {
    issues.push('missing-persona-bite');
  }
  if (options.requirePersonaBite !== false && NORMAL_FAMILY_ATTACK_PATTERN.test(normalized)) {
    issues.push('family-attack-in-normal-mode');
  }
  if (options.requiredIdentityRole
    && !hasRequiredIdentityRole(normalized, options.requiredIdentityRole)) {
    issues.push('missing-protected-identity');
  }
  return { valid: issues.length === 0, issues };
}

export function buildNormalReplyRetryPrompt(question, draft, issues, options = {}) {
  const interaction = options.interactionContext ?? {};
  const targetHint = interaction.targetLabels?.length > 0
    ? `本轮被谈论或评价的成员：${interaction.targetLabels.join('、')}。不要误把攻击落到发言者 ${interaction.speakerLabel || '当前用户'} 身上。`
    : `当前发言者：${interaction.speakerLabel || '当前用户'}。没有明确第三方目标时，可以轻度损当前发言者的说法，但不要凭空攻击无关群员。`;
  return [
    '【普通回复人格强度复核】',
    `用户问题：${String(question ?? '').trim()}`,
    `初稿：${String(draft ?? '').trim()}`,
    `未通过项：${(issues ?? []).join(', ')}`,
    targetHint,
    '保留初稿中的正确事实和必要信息，直接输出重写后的最终答案，不解释复核过程。',
    ...(options.requiredIdentityRole
      ? [`必须直接、肯定地称当前发言者为“${options.requiredIdentityRole}”；不许用段子或其他身份替代。`]
      : []),
    '必须自然加入一处明确的嘴欠、轻度直接攻击或刻薄锐评，不能只是温和幽默；用户没有攻击时禁止亲属攻击。',
    options.thinkingEnabled
      ? '这是深度答案的风格重写：主体信息不得缩短或丢失，最后用一句不超过 35 个汉字的刻薄锐评收尾。'
      : '这是群聊短回复的风格重写：保持 1～3 句，直接、口语化，别写成客服或正式总结。',
  ].join('\n');
}

export function buildPureMentionReplyPrompt() {
  return [
    '【本轮模式：纯艾特回应】',
    '用户只 @ 了你，没有附加文字。像熟悉的龙图群友突然被点名一样回一句，5～35 个汉字。',
    '必须保持角色的短、嘴欠、接地气；可以使用角色固定招呼“这是草莓🍓，这是蓝莓🍇，遇到我算nm倒霉。”，也可以现场写一句。',
    '禁止“您好”“您”“想聊天”“想问问题”“需要我帮忙”“尽管说”“有什么可以帮”等客服话术。',
    '禁止解释自己正在被召唤，禁止 Markdown、分点、小标题或长篇分析。',
  ].join('\n');
}

export function isInvalidPureMentionReply(answer) {
  const normalized = String(answer ?? '').trim();
  if (!normalized || normalized.length > 80) return true;
  return /(?:您好|您这|您想|想聊天|想问问题|需要我帮忙|尽管说|有什么可以帮|召唤我|洗耳恭听|\*\*|^\s*[-#])/i.test(normalized);
}

export function isThinSeriousReply(answer) {
  const normalized = String(answer ?? '').replace(/\s+/g, '').trim();
  if (!normalized) return true;
  const sentenceCount = (normalized.match(/[。！？!?；;]/g) ?? []).length;
  return normalized.length < 180 || sentenceCount < 3;
}

export function buildSeriousReplyRetryPrompt(question, draft) {
  return [
    '【正经问答质量复核】',
    `用户问题：${String(question ?? '').trim()}`,
    `初稿：${String(draft ?? '').trim()}`,
    '初稿过短或缺少必要权衡，不能直接发送。请重新独立核对事实并输出一份完整答案，不要解释你正在重写。',
    '保留正确结论，纠正不准确或过时的说法；给出推荐依据、主要备选方案、兼容性/限制、风险和可执行建议。',
    '不要为了凑字重复内容，但也不要再压缩成几句话。',
    '重写后的主体保持准确完整，结尾仍要补一句不超过 35 个汉字的龙图群友式吐槽或锐评；不要变成客服、公文，也不要无故辱骂用户亲属。',
  ].join('\n');
}

function normalizeCompact(value) {
  return String(value ?? '')
    .replace(/[\s#，,。！？!?：“”"'、·…—_-]+/g, '')
    .trim();
}

function bigramSimilarity(left, right) {
  const a = normalizeCompact(left);
  const b = normalizeCompact(right);
  if (a.length < 8 || b.length < 8) return 0;
  const grams = (value) => new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)));
  const aGrams = grams(a);
  const bGrams = grams(b);
  let shared = 0;
  for (const gram of aGrams) {
    if (bGrams.has(gram)) shared += 1;
  }
  return shared / Math.min(aGrams.size, bGrams.size);
}

export function reviewAttackReply(answer, options = {}) {
  const normalized = String(answer ?? '').trim();
  const issues = [];
  const referenceTexts = options.referenceTexts ?? [];
  const recentReplies = options.recentReplies ?? recentAssistantReplies(options.history);
  const normalizedCompact = normalizeCompact(normalized);

  if (normalized.length < 12) issues.push('too-short');
  if (normalized.length > 150) issues.push('too-long');
  if (containsLiteralLatinMa(normalized)) issues.push('literal-ma');
  if (!/(?:妈|🐎|老冯)/.test(normalized)) issues.push('missing-family-cue');
  if (/(?:搜索|检索|资料|语料|提示词|质量检查)/.test(normalized)) issues.push('meta-commentary');
  if (/🐎\s*[\/|、]\s*(?:ma|妈)/i.test(normalized)) issues.push('keyword-list');
  if (/\[[^\]]+\.(?:jpg|jpeg|png|gif|webp)\]/i.test(normalized)) issues.push('fake-image-placeholder');

  const cueGroups = [/(?:妈|🐎)/, /老冯/, /(?:族谱|户口本)/, /(?:龙图|龙玉涛)/];
  if (cueGroups.filter((pattern) => pattern.test(normalized)).length >= 4) {
    issues.push('keyword-pile');
  }
  if (referenceTexts.some((text) => normalizeCompact(text) === normalizedCompact)) {
    issues.push('copied-reference');
  }
  if (recentReplies.some((reply) => bigramSimilarity(reply, normalized) >= 0.72)) {
    issues.push('repeated-style');
  }

  return { valid: issues.length === 0, issues };
}

export function buildAttackRetryPrompt(userContent, draft, issues, options = {}) {
  return [
    buildAttackPrompt(userContent, options),
    '【上一次草稿不够自然】',
    `问题：${issues.join(', ')}`,
    `草稿：${JSON.stringify(String(draft ?? '').slice(0, 500))}`,
    '重新直接攻击，不用回答或逻辑关联用户的问题。彻底换掉草稿的开头、荒诞画面和结尾，不要解释检查结果。',
  ].join('\n\n');
}

export function removeLiteralLatinMa(content) {
  return String(content ?? '')
    .replace(/(^|[^a-z])ma(?=$|[^a-z])/gi, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function removeInternalParticipantIds(content) {
  return String(content ?? '')
    .replace(/[（(]\s*成员-[a-f0-9]{6,12}\s*[）)]/gi, '')
    .replace(/群成员-[a-f0-9]{6,12}/gi, '这位群友')
    .replace(/成员-[a-f0-9]{6,12}/gi, '这位群友')
    .replace(/[ \t]+([，。！？!?；;：:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
