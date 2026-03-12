"use strict";
// Session-based in-memory store for recent conversation turns.
// Keyed by platform:channel:entityId — separate per scene.
// Group chats share one session (by chatId); private chats are per-user.

const MAX_TURNS = 20; // 20 pairs = 40 messages max
const sessions = new Map();

/**
 * Generate a session key from a raw event.
 * @param {object} event
 * @returns {string}
 */
function makeSessionKey(event) {
  const platform = event.platform || event.connector || "unknown";
  const isPrivate = Boolean(event.isPrivate || event.channel === "private");
  const channel = isPrivate ? "private" : (event.channel || "group");
  // Group: key by chatId/groupId so all members share history.
  // Private: key by userId so each user has isolated history.
  const entityId = (!isPrivate)
    ? (event.chatId || event.groupId || event.channel_id || "default_group")
    : (String(event.userId || event.speaker_id || "anon"));
  return `${platform}:${channel}:${entityId}`;
}

/**
 * Returns the session array for a given key (creates if missing).
 * @param {string} key
 * @returns {Array}
 */
function getSession(key) {
  if (!sessions.has(key)) sessions.set(key, []);
  return sessions.get(key);
}

/**
 * Appends a user+AI turn to the session.
 * @param {string} key
 * @param {string} speakerId
 * @param {string} speakerName
 * @param {string} userText
 * @param {string} aiText
 */
function addTurn(key, speakerId, speakerName, userText, aiText) {
  const session = getSession(key);
  const ts = Date.now();
  session.push({ role: "user",      speaker_id: speakerId, speaker_name: speakerName, text: userText,  ts });
  session.push({ role: "assistant", speaker_id: "ai",       speaker_name: "晴",         text: aiText,   ts });
  // Trim oldest pairs when over limit
  while (session.length > MAX_TURNS * 2) session.splice(0, 2);
}

/**
 * Clear a session (e.g. on explicit /reset command).
 * @param {string} key
 */
function clearSession(key) {
  sessions.delete(key);
}

/**
 * Stats for monitoring.
 */
function getStats() {
  return {
    activeSessions: sessions.size,
    totalMessages: [...sessions.values()].reduce((a, s) => a + s.length, 0),
  };
}

module.exports = { makeSessionKey, getSession, addTurn, clearSession, getStats };
