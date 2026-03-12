"use strict";

function normalizeText(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isEcho(userText = "", aiReply = "") {
  const u = normalizeText(userText);
  const a = normalizeText(aiReply);
  if (!u || !a) return false;
  const probe = u.slice(0, 15);
  if (!probe) return false;
  return a.includes(probe) || a.startsWith(u);
}

function isAssistantEcho(lastAssistantReply = "", aiReply = "") {
  const prev = normalizeText(lastAssistantReply);
  const cur = normalizeText(aiReply);
  if (!prev || !cur) return false;
  return prev === cur;
}

function detectEcho({ userText = "", aiReply = "", lastAssistantReply = "" } = {}) {
  if (isEcho(userText, aiReply)) {
    return { detected: true, reason: "user_echo" };
  }
  if (isAssistantEcho(lastAssistantReply, aiReply)) {
    return { detected: true, reason: "assistant_repeat" };
  }
  return { detected: false, reason: "none" };
}

module.exports = {
  isEcho,
  isAssistantEcho,
  detectEcho,
};
