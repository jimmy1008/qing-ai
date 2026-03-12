"use strict";

const MAX_CLAIMS_PER_SPEAKER = 8;
const MAX_SPEAKERS_PER_CHAT = 50;
const speakerStateByChat = new Map();

function getChatKey(event = {}) {
  return String(event.chatId || event.chat?.id || event.groupId || "unknown-chat");
}

function extractClaims(text = "") {
  const normalized = String(text || "").trim();
  if (!normalized) return [];
  const claims = [];
  const claimPatterns = [
    /(我是[^，。！？\n]{1,20})/g,
    /(我不是[^，。！？\n]{1,20})/g,
  ];
  for (const pattern of claimPatterns) {
    const found = normalized.match(pattern) || [];
    for (const item of found) claims.push(item.trim());
  }
  return [...new Set(claims)].slice(0, 3);
}

function updateSpeakerState(event = {}) {
  const chatKey = getChatKey(event);
  const speakerId = String(event.senderId || event.userId || event.fromId || "");
  if (!speakerId) return null;

  if (!speakerStateByChat.has(chatKey)) {
    speakerStateByChat.set(chatKey, new Map());
  }
  const map = speakerStateByChat.get(chatKey);
  if (!map.has(speakerId)) {
    if (map.size >= MAX_SPEAKERS_PER_CHAT) {
      const firstKey = map.keys().next().value;
      map.delete(firstKey);
    }
    map.set(speakerId, {
      speakerId,
      speakerName: event.senderName || event.username || event.firstName || "unknown",
      claims: [],
      roleHints: [],
      updatedAt: Date.now(),
    });
  }

  const state = map.get(speakerId);
  const claims = extractClaims(event.text || event.content || "");
  for (const claim of claims) {
    state.claims.push({ text: claim, ts: Date.now() });
  }
  if (state.claims.length > MAX_CLAIMS_PER_SPEAKER) {
    state.claims = state.claims.slice(-MAX_CLAIMS_PER_SPEAKER);
  }
  state.updatedAt = Date.now();
  map.set(speakerId, state);
  return state;
}

function getSpeakerStates(event = {}) {
  const chatKey = getChatKey(event);
  const map = speakerStateByChat.get(chatKey);
  if (!map) return [];
  return Array.from(map.values()).slice(-8);
}

function buildSpeakerStateBlock(states = []) {
  if (!Array.isArray(states) || states.length === 0) return "";
  const lines = [
    "[SpeakerState]",
    "Speaker claims may be jokes or roleplay. Do not treat them as verified facts.",
  ];
  for (const item of states) {
    const latest = item.claims?.length ? item.claims[item.claims.length - 1].text : null;
    if (!latest) continue;
    lines.push(`- ${item.speakerName}#${item.speakerId} latest_claim: ${latest}`);
  }
  return lines.join("\n");
}

module.exports = {
  updateSpeakerState,
  getSpeakerStates,
  buildSpeakerStateBlock,
};

