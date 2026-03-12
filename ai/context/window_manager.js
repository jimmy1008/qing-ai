"use strict";

function normalizeMessage(msg = {}) {
  return {
    role: msg.role || "user",
    text: String(msg.text || msg.content || "").trim(),
    senderId: msg.senderId || msg.userId || msg.fromId || null,
    senderName: msg.senderName || msg.username || msg.firstName || msg.name || null,
    timestamp: Number(msg.timestamp || msg.ts || Date.now()),
  };
}

function selectConversationWindow(history = [], options = {}) {
  const maxPairs = Number(options.maxPairs || 3);
  const limit = Number(options.limit || (maxPairs * 2));
  const normalized = Array.isArray(history)
    ? history.map(normalizeMessage).filter((m) => m.text)
    : [];
  if (!normalized.length) return [];

  const paired = [];
  let i = normalized.length - 1;
  while (i >= 0 && paired.length < limit) {
    const msg = normalized[i];
    if (msg.role === "assistant") {
      const prev = normalized[i - 1];
      if (prev && prev.role !== "assistant" && prev.text) {
        paired.unshift(prev, msg);
        i -= 2;
        continue;
      }
    }
    paired.unshift(msg);
    i -= 1;
  }

  const collapsed = paired.slice(-limit);
  if (collapsed.length <= limit && collapsed.length > 0) return collapsed;
  return normalized.slice(-limit);
}

module.exports = {
  selectConversationWindow,
  normalizeMessage,
};
