"use strict";

function normalizeName(name = "") {
  return String(name || "").replace(/^@/, "").trim();
}

function parseMentionedUsernames(text = "") {
  const input = String(text || "");
  const matches = input.match(/@([A-Za-z0-9_\.]+)/g) || [];
  return matches.map((m) => normalizeName(m));
}

function detectTargetSpeaker({ event = {}, conversationWindow = [], identityMap = {} } = {}) {
  const currentSpeaker = {
    id: String(event.senderId || event.userId || event.fromId || ""),
    name: event.senderName || event.username || event.firstName || "unknown",
  };

  const replied = event.replyToMessage || event.reply_to_message || null;
  if (replied && (replied.fromId || replied.userId || replied.username || replied.firstName)) {
    return {
      currentSpeaker,
      targetSpeaker: {
        id: String(replied.fromId || replied.userId || ""),
        name: replied.username || replied.firstName || "unknown",
      },
      reason: "reply_to_message",
    };
  }

  const mentioned = parseMentionedUsernames(event.text || event.content || "");
  if (mentioned.length > 0) {
    const target = Object.values(identityMap).find((user) => mentioned.includes(normalizeName(user.name)));
    if (target) {
      return {
        currentSpeaker,
        targetSpeaker: { id: String(target.id || ""), name: target.name || "unknown" },
        reason: "username_mention",
      };
    }
    return {
      currentSpeaker,
      targetSpeaker: { id: "", name: `@${mentioned[0]}` },
      reason: "username_mention_unmapped",
    };
  }

  const lastSpeaker = [...(conversationWindow || [])]
    .reverse()
    .find((m) => String(m.senderId || "") && String(m.senderId) !== currentSpeaker.id);

  return {
    currentSpeaker,
    targetSpeaker: lastSpeaker
      ? {
          id: String(lastSpeaker.senderId || ""),
          name: lastSpeaker.senderName || lastSpeaker.username || "unknown",
        }
      : null,
    reason: lastSpeaker ? "last_speaker" : "none",
  };
}

function buildTargetBlock(targetState = {}) {
  const current = targetState.currentSpeaker || {};
  const target = targetState.targetSpeaker || null;
  return [
    "[TargetDetection]",
    `- currentSpeaker: ${current.name || "unknown"}#${current.id || "unknown"}`,
    `- targetSpeaker: ${target ? `${target.name || "unknown"}#${target.id || "unknown"}` : "none"}`,
    `- targetReason: ${targetState.reason || "none"}`,
  ].join("\n");
}

module.exports = {
  detectTargetSpeaker,
  buildTargetBlock,
};

