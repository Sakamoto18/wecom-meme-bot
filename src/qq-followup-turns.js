// Collect only the addressed human's next messages, before the per-group queue.
// No send pacing: a bare @ waits silently; actual questions start immediately.
export class QqFollowupTurns {
  constructor({ now = Date.now, windowMs = 30_000 } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.turns = new Map();
  }

  accept(payload, { direct = false, peer = false, command = false } = {}) {
    if (payload.messageType !== 'group' || !payload.botUserId || peer) return null;
    const key = JSON.stringify([payload.botUserId, payload.groupId, payload.userId]);
    for (const [id, turn] of this.turns) if (this.now() - turn.updatedAt > (turn.base ? 120_000 : this.windowMs)) this.turns.delete(id);
    let turn = this.turns.get(key);
    if (command || payload.mentions.some(p => p.userId !== payload.botUserId)
      || (payload.quotedAuthor && payload.quotedAuthor.userId !== payload.botUserId)) {
      return null;
    }
    if (!turn && !direct) return null;
    if (payload.messageId && turn?.ids.has(payload.messageId)) return { duplicate: true };
    if (turn?.count >= 5) return null;
    if (!turn) {
      turn = { revision: 0, count: 0, ids: new Set(), parts: [], base: null, updatedAt: this.now() };
      if (this.turns.size >= 1000) this.turns.delete(this.turns.keys().next().value);
      this.turns.set(key, turn);
    }
    turn.revision++; turn.count++; turn.updatedAt = this.now();
    if (payload.messageId) turn.ids.add(payload.messageId);
    const revision = turn.revision;
    const stale = () => turn.revision !== revision;
    if (payload.pureBotMention) {
      turn.context = payload.recentGroupContext;
      return { waiting: true, stale };
    }
    if (payload.text) turn.parts.push(payload.text);
    const previous = turn.base;
    if (!payload.recentGroupContext?.messages?.length && turn.context) payload.recentGroupContext = turn.context;
    if (previous) {
      for (const field of ['imageBase64s', 'quotedImageBase64s', 'forwardImageBase64s', 'quotedForwardImageBase64s']) {
        payload[field] = [...new Set([...(previous[field] || []), ...(payload[field] || [])])].slice(0, 4);
      }
      for (const field of ['quotedText', 'quotedMessageId', 'quotedAuthor', 'forwardedText', 'quotedForwardedText']) {
        if (!payload[field]) payload[field] = previous[field];
      }
      payload.hasImage ||= previous.hasImage;
      payload.imageBase64 = payload.imageBase64s[0] || '';
      payload.quotedImageBase64 = payload.quotedImageBase64s[0] || '';
    }
    payload.text = turn.parts.join('\n').slice(0, 6000);
    payload.pureBotMention = false;
    payload.observeOnly = false;
    if (!payload.mentions.some(p => p.userId === payload.botUserId)) payload.mentions.push({ userId: payload.botUserId, name: '' });
    payload.followupStale = stale;
    turn.base = { ...payload };
    return { stale, finish: () => { if (!stale() && this.turns.get(key) === turn) this.turns.delete(key); } };
  }
}
