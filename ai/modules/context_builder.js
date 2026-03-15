"use strict";
// Module 1: context_builder
// Converts raw platform event → standardized context_packet.
// NO LLM — pure data transformation + working memory lookup.
//
// context_packet schema:
// {
//   platform: string,
//   scene: "private" | "group" | "public_comment",
//   speaker: { id, name, role },
//   recent_messages: [{ role, speaker_id, speaker_name, text, ts }],
//   current_message: { text, reply_to, mentions },
//   meta: { is_developer_present, connector, channel, isPrivate, session_key }
// }

const { makeSessionKey, getSession } = require("../memory/working_memory");
const developerConfig = require("../../config/developer_config");

function buildContextPacket(event) {
  const sessionKey = makeSessionKey(event);
  const recentMessages = getSession(sessionKey).slice(-12); // last 6 turns

  return {
    platform: event.platform || event.connector || "unknown",
    scene:    determineScene(event),
    speaker:  extractSpeaker(event),
    recent_messages: recentMessages,
    current_message: extractCurrentMessage(event),
    meta: {
      ...(event.meta || {}),              // pass through connector-set meta (firstMeeting, absenceDays, groupId, etc.)
      is_developer_present: checkDeveloperPresent(event),
      connector:   event.connector || null,
      channel:     event.channel  || "unknown",
      isPrivate:   Boolean(event.isPrivate || event.channel === "private"),
      session_key: sessionKey,
      raw_event_type: event.type || null,
    },
  };
}

function determineScene(event) {
  if (event.isPrivate || event.channel === "private") return "private";
  if (event.connector === "threads_browser" || event.platform === "threads") return "public_comment";
  return "group";
}

function extractSpeaker(event) {
  return {
    id:   String(event.userId || event.speaker_id || event.fromId || "unknown"),
    name: event.username || event.firstName || event.speaker_name || "對方",
    role: event.role || "public_user",
  };
}

function extractCurrentMessage(event) {
  return {
    text:     String(event.content || event.text || event.message || "").trim(),
    reply_to: event.replyTo || event.reply_to_message_id || null,
    mentions: Array.isArray(event.mentions) ? event.mentions : [],
  };
}

function checkDeveloperPresent(event) {
  if (event.role === "developer") return true;
  const profiles = developerConfig?.profile || {};
  const uid = String(event.userId || event.speaker_id || "");
  return Boolean(uid && profiles[uid]);
}

module.exports = { buildContextPacket };
