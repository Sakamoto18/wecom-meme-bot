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

export function getGroupInteractionContext(message, memberAliases = {}) {
  if (message?.chattype !== 'group') {
    return {
      speakerLabel: '',
      targetLabels: [],
      quotedAuthorLabel: '',
      hasThirdPartyTarget: false,
    };
  }
  const senderId = String(message?.from?.userid ?? '').trim();
  const botUserId = String(message?.bot_user_id ?? '').trim();
  const speakerLabel = getParticipantLabel(
    senderId,
    message?.from?.name,
    memberAliases,
  );
  const mentions = distinctParticipants(message?.mentions ?? [])
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
  return {
    speakerLabel,
    targetLabels,
    quotedAuthorLabel,
    hasThirdPartyTarget: targetLabels.length > 0,
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
