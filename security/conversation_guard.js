const { clamp } = require("../utils/math");

const pausedChats = new Map();

const FORBIDDEN_PATTERNS = [
  /<tool_call>/i,
  /<\/tool_call>/i,
  /\[object Object\]/i,
  /\bundefined\b/i,
  /\bnull\b/i,
];

function isInvalidResponse(text) {
  if (!text) return true;
  if (typeof text !== "string") return true;

  const trimmed = text.trim();
  if (trimmed.length < 3) return true;

  const weirdChars = trimmed.replace(/[a-zA-Z0-9　-鿿\s.,!?@‘’“”\-:：；()（）]/g, "");
  const weirdCharRatio = weirdChars.length / Math.max(trimmed.length, 1);
  if (weirdCharRatio > 0.3) return true;

  if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  if (/@\s/.test(trimmed)) return true;

  return false;
}

function shouldTriggerGuard(context = {}) {
  const {
    text,
    personaModeKey,
    role,
    channel,
  } = context;

  if (channel !== "private" && channel !== "group") return false;
  if (!personaModeKey) return true;
  if (!role) return true;
  if (isInvalidResponse(text)) return true;

  return false;
}

function pauseConversation(chatId, ttlMs = null) {
  if (!chatId) return;
  const expiresAt = typeof ttlMs === "number" && ttlMs > 0
    ? Date.now() + ttlMs
    : null;
  pausedChats.set(String(chatId), expiresAt);
}

function resumeConversation(chatId) {
  if (!chatId) return;
  pausedChats.delete(String(chatId));
}

function isPaused(chatId) {
  if (!chatId) return false;
  const key = String(chatId);
  if (!pausedChats.has(key)) return false;
  const expiresAt = pausedChats.get(key);
  if (typeof expiresAt === "number" && Date.now() > expiresAt) {
    pausedChats.delete(key);
    return false;
  }
  return true;
}

function getPausedChatIds() {
  const now = Date.now();
  return Array.from(pausedChats.entries())
    .filter(([, expiresAt]) => !(typeof expiresAt === "number" && now > expiresAt))
    .map(([chatId]) => chatId);
}

module.exports = {
  shouldTriggerGuard,
  pauseConversation,
  resumeConversation,
  isPaused,
  getPausedChatIds,
};
