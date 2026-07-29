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

function getAnonymousSpeakerLabel(message) {
  const digest = createHash('sha256')
    .update(String(message?.from?.userid ?? 'anonymous'))
    .digest('hex')
    .slice(0, 6);
  return '群成员-' + digest;
}

export function buildModelInput(message, content) {
  const quotedContent = extractMessageText(message?.quote);
  if (message?.chattype !== 'group') {
    return quotedContent
      ? '引用消息：' + quotedContent + '\n当前消息：' + content
      : content;
  }

  const lines = ['发言人：' + getAnonymousSpeakerLabel(message)];
  if (quotedContent) lines.push('引用消息：' + quotedContent);
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
