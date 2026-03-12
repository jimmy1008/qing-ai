"use strict";

function resolveSpeakerName(msg = {}) {
  return msg.senderName
    || msg.username
    || msg.firstName
    || msg.name
    || "unknown";
}

function resolveSpeakerId(msg = {}) {
  return msg.senderId || msg.userId || msg.fromId || "unknown";
}

function formatSpeaker(msg = {}) {
  const speakerName = resolveSpeakerName(msg);
  const speakerId = resolveSpeakerId(msg);
  const text = String(msg.text || msg.content || "").trim();
  return `[USER:${speakerName}#${speakerId}]\n${text}`;
}

function formatSpeakerHistory(history = []) {
  return history
    .map((msg) => formatSpeaker(msg))
    .filter((line) => line && !line.endsWith("\n"));
}

module.exports = {
  formatSpeaker,
  formatSpeakerHistory,
  resolveSpeakerName,
  resolveSpeakerId,
};

