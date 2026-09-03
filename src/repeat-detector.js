const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_TEXT_CHARACTERS = 500;
const DEFAULT_MAX_GROUPS = 1_000;

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\r\n\t ]+/g, ' ')
    .trim();
}

/**
 * Detects a short, cross-user run of identical group messages.
 *
 * This is deliberately deterministic and does not call the LLM.  A run is
 * considered a repeat only after two different users have sent the same text;
 * the detector then marks that run as handled so a third copy cannot make the
 * bot repeat it again.
 */
export class RepeatDetector {
  constructor(options = {}) {
    this.enabled = options.enabled ?? true;
    this.windowMs = Math.max(1_000, Number(options.windowMs ?? DEFAULT_WINDOW_MS));
    this.maxTextCharacters = Math.max(
      1,
      Math.floor(Number(options.maxTextCharacters ?? DEFAULT_MAX_TEXT_CHARACTERS)),
    );
    this.maxGroups = Math.max(1, Math.floor(Number(options.maxGroups ?? DEFAULT_MAX_GROUPS)));
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.groups = new Map();
  }

  normalize(value) {
    const text = normalizeText(value);
    return text.length <= this.maxTextCharacters ? text : '';
  }

  reset(groupId) {
    const key = String(groupId ?? '').trim();
    if (key) this.groups.delete(key);
  }

  detect(payload, now = this.now()) {
    if (!this.enabled || payload?.messageType !== 'group') return null;
    const groupId = String(payload?.groupId ?? '').trim();
    const userId = String(payload?.userId ?? '').trim();
    if (!groupId || !userId) return null;
    if (payload?.isPeerBot) {
      this.reset(groupId);
      return null;
    }
    if (payload?.botUserId && userId === String(payload.botUserId)) {
      this.reset(groupId);
      return null;
    }
    if (payload?.hasImage || payload?.forwardedText || payload?.quotedText
      || payload?.quotedForwardedText || payload?.pureBotMention) {
      this.reset(groupId);
      return null;
    }
    const text = this.normalize(payload?.text);
    if (!text) {
      this.reset(groupId);
      return null;
    }
    if (/^\s*\//.test(text) || (payload?.mentions ?? []).length > 0
      || payload?.quotedAuthor?.userId) {
      this.reset(groupId);
      return null;
    }

    const previous = this.groups.get(groupId);
    const sameRun = previous
      && previous.fingerprint === text
      && now - previous.lastAt >= 0
      && now - previous.lastAt <= this.windowMs;
    const state = sameRun
      ? previous
      : {
        fingerprint: text,
        displayText: String(payload.text ?? '').trim().slice(0, this.maxTextCharacters),
        users: new Set(),
        lastAt: now,
        handled: false,
      };
    state.users.add(userId);
    state.lastAt = now;
    if (!sameRun) {
      this.groups.set(groupId, state);
      while (this.groups.size > this.maxGroups) {
        const oldestGroupId = [...this.groups.entries()]
          .sort((left, right) => left[1].lastAt - right[1].lastAt)[0]?.[0];
        if (!oldestGroupId) break;
        this.groups.delete(oldestGroupId);
      }
    }

    if (state.handled || state.users.size < 2) return null;
    state.handled = true;
    this.logger.log?.(
      `QQ 复读检测触发：${groupId}，${state.users.size} 位群友重复“${state.displayText}”`,
    );
    return {
      text: state.displayText || text,
      userCount: state.users.size,
      reason: 'cross-user-repeat',
    };
  }
}

export function normalizeRepeatText(value) {
  return normalizeText(value);
}
