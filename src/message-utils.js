import { createHash } from 'node:crypto';

export function stripBotMention(content) {
  return String(content ?? '')
    .trim()
    .replace(/^@\S+\s+/, '')
    .trim();
}

export function extractMessageText(message) {
  if (!message) return '';

  if (message.msgtype === 'text') {
    return stripBotMention(message.text?.content);
  }
  if (message.msgtype === 'voice') {
    return String(message.voice?.content ?? '').trim();
  }
  if (message.msgtype === 'mixed') {
    return (message.mixed?.msg_item ?? [])
      .filter((item) => item.msgtype === 'text')
      .map((item) => stripBotMention(item.text?.content))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function hasImageContent(message) {
  if (message?.msgtype === 'image') {
    return true;
  }
  return message?.msgtype === 'mixed'
    && (message.mixed?.msg_item ?? []).some((item) => item.msgtype === 'image');
}

export function getAnonymousSpeakerId(message) {
  return getStableParticipantId(message?.from?.userid);
}

export function getStableParticipantId(userId) {
  return createHash('sha256')
    .update(String(userId ?? 'anonymous'))
    .digest('hex')
    .slice(0, 6);
}

function normalizeDisplayName(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 40);
}

export function getParticipantLabel(userId, displayName, memberAliases = {}) {
  const speakerId = getStableParticipantId(userId);
  const configuredAlias = memberAliases?.[speakerId];
  const normalizedAlias = normalizeDisplayName(configuredAlias)
    || normalizeDisplayName(displayName);
  return normalizedAlias
    ? `${normalizedAlias}（成员-${speakerId}）`
    : '群成员-' + speakerId;
}

function distinctParticipants(participants) {
  const seen = new Set();
  return participants.filter((participant) => {
    const userId = String(participant?.user_id ?? participant?.userid ?? '').trim();
    if (!userId || seen.has(userId)) return false;
    seen.add(userId);
    return true;
  });
}

function normalizeBotNames(message) {
  const configured = [
    ...(Array.isArray(message?.bot_names) ? message.bot_names : []),
    message?.bot_name,
  ]
    .map((value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, '').trim())
    .filter((value) => value.length >= 2 && value.length <= 32);
  return [...new Set(configured)];
}

function compactMessageText(message) {
  return extractMessageText(message)
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function possibleNameAfterFarewell(text) {
  const match = text.match(
    /(?:再见|拜拜|bye(?:\s*bye)?|走了|退场|退位|下线|离开|告别)[了啦啊呀嘛\s，,:：、-]*([\p{L}\p{N}][\p{L}\p{N}·_-]{1,10})/iu,
  );
  const candidate = String(match?.[1] ?? '').trim();
  return candidate && !/^(?:了|吧|啊|呀|嘛|大家|各位|群里|我们)$/u.test(candidate)
    ? candidate : '';
}

function escapePattern(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function detectBotAddress(text, botNames, explicitlyMentioned = false, explicitBotName = '') {
  const matched = botNames
    .filter((name) => text.includes(name))
    .sort((left, right) => right.length - left.length)[0]
    || (explicitlyMentioned ? String(explicitBotName || botNames[0] || '').trim() : '');
  const farewell = /(?:再见|拜拜|bye(?:\s*bye)?|走了|退场|退位|下线|离开|滚蛋|告别)/iu.test(text);
  const correction = /(?:我(?:是说|的意思是|指的是)|不是(?:说|我)|你(?:要|得|才|这)|说的是你|指的是你|我让你)/u.test(text);
  const questionLike = /(?:怎么|如何|为什么|为何|什么|哪|能不能|是不是|吗[？?]?$)/u.test(text);
  const directNameAddress = Boolean(
    matched
    && (explicitlyMentioned
      || text === matched
      || new RegExp(`^${escapePattern(matched)}(?:[，,。！？!?：:\s]|$)`, 'u').test(text)
        && (farewell || correction || questionLike)),
  );
  if (!matched) {
    const candidate = possibleNameAfterFarewell(text);
    return {
      addressedBotByName: false,
      addressedBotName: '',
      isFarewellToBot: false,
      isCorrectionOfPreviousReply: false,
      userIntent: '',
      botAddressCandidate: candidate,
      botAddressCandidateIsUntrusted: Boolean(candidate),
      botAddressCandidateSpeechAct: candidate ? 'farewell' : '',
      correctionCandidate: /(?:我是说|我的意思是|我指的是|不是(?:说|我)|说的是你|指的是你|我让你)/u.test(text),
    };
  }

  // A name alone is not enough to call this a correction or a farewell. The
  // surrounding verb supplies the speech act, which prevents a historical
  // mention of the bot name from hijacking an otherwise unrelated question.
  if (!directNameAddress) {
    return {
      addressedBotByName: false,
      addressedBotName: '',
      isFarewellToBot: false,
      isCorrectionOfPreviousReply: false,
      userIntent: '',
      botAddressCandidate: matched,
      botAddressCandidateIsUntrusted: true,
      botAddressCandidateSpeechAct: farewell ? 'farewell' : '',
      correctionCandidate: correction,
    };
  }
  const userIntent = farewell
    ? 'farewell-to-bot'
    : (correction ? 'correcting-bot-interpretation' : (questionLike ? 'addressing-bot-question' : 'addressing-bot'));
  return {
    addressedBotByName: true,
    addressedBotName: matched,
    isFarewellToBot: farewell,
    isCorrectionOfPreviousReply: correction,
    userIntent,
    botAddressCandidate: matched,
    botAddressCandidateIsUntrusted: false,
    botAddressCandidateSpeechAct: farewell ? 'farewell' : '',
    correctionCandidate: false,
  };
}

export function getGroupInteractionContext(message, memberAliases = {}) {
  if (message?.chattype !== 'group') {
    return {
      speakerLabel: '',
      targetLabels: [],
      quotedAuthorLabel: '',
      hasThirdPartyTarget: false,
      addressedBotByName: false,
      addressedBotName: '',
      isFarewellToBot: false,
      isCorrectionOfPreviousReply: false,
      userIntent: '',
      botAddressCandidate: '',
      botAddressCandidateIsUntrusted: false,
      botAddressCandidateSpeechAct: '',
      correctionCandidate: false,
    };
  }
  const senderId = String(message?.from?.userid ?? '').trim();
  const botUserId = String(message?.bot_user_id ?? '').trim();
  const speakerLabel = getParticipantLabel(
    senderId,
    message?.from?.name,
    memberAliases,
  );
  const allMentions = distinctParticipants(message?.mentions ?? []);
  const mentions = allMentions
    .filter((participant) => {
      const userId = String(participant?.user_id ?? participant?.userid ?? '').trim();
      return userId !== senderId && userId !== botUserId;
    });
  const targetLabels = mentions.map((participant) => getParticipantLabel(
    participant.user_id ?? participant.userid,
    participant.name,
    memberAliases,
  ));
  const quotedAuthorId = String(message?.quote?.from?.userid ?? '').trim();
  const quotedBot = Boolean(quotedAuthorId && quotedAuthorId === botUserId);
  const quotedAuthorLabel = quotedAuthorId && quotedAuthorId !== botUserId
    ? getParticipantLabel(
      quotedAuthorId,
      message?.quote?.from?.name,
      memberAliases,
    )
    : '';
  if (quotedAuthorLabel
    && quotedAuthorId !== senderId
    && !targetLabels.includes(quotedAuthorLabel)) {
    targetLabels.push(quotedAuthorLabel);
  }
  // `mentions` above is deliberately filtered for third-party target labels,
  // so keep the raw list for the separate relation signal. The old code
  // checked the filtered list and therefore could never confirm a real @bot.
  const explicitBotParticipant = allMentions.find((participant) => (
    String(participant?.user_id ?? participant?.userid ?? '').trim() === botUserId
  ));
  const explicitBotMention = Boolean(explicitBotParticipant);
  const botAddress = detectBotAddress(
    compactMessageText(message),
    normalizeBotNames(message),
    explicitBotMention,
    normalizeDisplayName(explicitBotParticipant?.name),
  );
  return {
    speakerLabel,
    targetLabels,
    quotedAuthorLabel,
    quotedBot,
    hasThirdPartyTarget: targetLabels.length > 0,
    ...botAddress,
  };
}

export function buildModelInput(message, content, memberAliases = {}) {
  const quotedContent = extractMessageText(message?.quote);
  if (message?.chattype !== 'group') {
    return quotedContent
      ? '引用消息：' + quotedContent + '\n当前消息：' + content
      : content;
  }

  const interaction = getGroupInteractionContext(message, memberAliases);
  const lines = ['当前发言人：' + interaction.speakerLabel];
  if (interaction.targetLabels.length > 0) {
    lines.push('本条消息指向或提到的群成员：' + interaction.targetLabels.join('、'));
  }
  if (interaction.quotedAuthorLabel) {
    lines.push('引用消息作者：' + interaction.quotedAuthorLabel);
  }
  if (interaction.addressedBotByName) {
    lines.push(`语用关系：当前消息正在称呼机器人“${interaction.addressedBotName}”并直接对机器人说话。`);
  }
  if (interaction.botAddressCandidateIsUntrusted) {
    lines.push(`语用候选（不确定，必须结合最近对话自行判断）：消息中出现了可能的称呼“${interaction.botAddressCandidate}”；不要仅凭这个候选改变回复对象。`);
    if (interaction.botAddressCandidateSpeechAct === 'farewell') {
      lines.push('语用候选动作：这句话的句式像是在向这个临时称呼告别；若上一轮机器人刚发言，优先检查是不是在让机器人退场，但不要把临时称呼写入固定别名。');
    }
  }
  if (interaction.isFarewellToBot) {
    lines.push('语用意图：这是让机器人退场/与机器人告别的说法，不是当前发言人在宣布自己要离开。');
  } else if (interaction.isCorrectionOfPreviousReply) {
    lines.push('语用意图：当前发言者正在纠正机器人上一轮的理解；先承认指代或意图判断错，再按这轮纠正后的意思回答。');
  } else if (interaction.correctionCandidate) {
    lines.push('语用候选（不确定）：当前消息可能在纠正上一轮回复；结合最近对话判断，不要继续为旧答案争辩。');
  }
  if (quotedContent) lines.push('引用消息内容：' + quotedContent);
  lines.push('当前消息：' + content);
  return lines.join('\n');
}

export function getConversationId(message) {
  const chatType = message?.chattype ?? 'unknown';
  const chatId = message?.chatid ?? 'missing-chat';
  const userId = message?.from?.userid ?? 'anonymous';
  if (chatType === 'group') {
    return 'group:' + chatId;
  }
  return chatType + ':' + userId;
}

export function getMessageTarget(message) {
  if (message?.chattype === 'group') {
    return String(message.chatid ?? '').trim();
  }
  return String(message?.from?.userid ?? '').trim();
}
