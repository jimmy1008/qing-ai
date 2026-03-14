"use strict";
/**
 * reaction_tracker.js
 *
 * In-memory store: Telegram message_id → AI reply context.
 * Used to match a user reaction back to the specific AI reply that caused it.
 *
 * Capacity: last 500 messages (LRU eviction).
 * TTL: 7 days (reactions older than this are ignored).
 */

const MAX_ENTRIES = 500;
const TTL_MS      = 7 * 24 * 60 * 60 * 1000; // 7 days

// Map: `${chatId}:${messageId}` → entry
const store = new Map();

/**
 * Record an AI reply after it's been sent.
 * @param {number} chatId
 * @param {number} messageId      — the bot message's message_id
 * @param {object} context        — { userId, globalKey, replyText, userText }
 */
function trackReply(chatId, messageId, context) {
  if (!chatId || !messageId) return;
  const key = `${chatId}:${messageId}`;
  store.set(key, { ...context, chatId, messageId, ts: Date.now() });
  // LRU eviction
  if (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

/**
 * Look up an AI reply by chatId + messageId.
 * Returns null if not found or expired.
 */
function lookupReply(chatId, messageId) {
  const key = `${chatId}:${messageId}`;
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    store.delete(key);
    return null;
  }
  return entry;
}

module.exports = { trackReply, lookupReply };
