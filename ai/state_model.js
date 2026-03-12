"use strict";

const STATE_MAP = new Map();

function clamp(v, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(v.toFixed(3))));
}

function defaultState() {
  return {
    curiosity: 0.6,
    playfulness: 0.5,
    attachment: 0.3,
    defensiveness: 0.1,
    annoyance: 0.1,
    tiredness: 0.1,
    updatedAt: Date.now(),
  };
}

function getState(key = "global") {
  const k = String(key || "global");
  if (!STATE_MAP.has(k)) STATE_MAP.set(k, defaultState());
  return { ...STATE_MAP.get(k) };
}

function updateState(key = "global", input = {}) {
  const k = String(key || "global");
  const prev = getState(k);
  const text = String(input.userInput || "");
  const historyLen = Number(input.conversationLength || 0);

  let next = { ...prev };

  // decay
  next.curiosity *= 0.95;
  next.playfulness *= 0.95;
  next.attachment *= 0.97;
  next.defensiveness *= 0.93;
  next.annoyance *= 0.93;
  next.tiredness *= 0.98;

  if (/謝謝|好棒|厲害|喜歡你|很讚/.test(text)) {
    next.playfulness += 0.1;
    next.attachment += 0.05;
  }
  if (/敷衍|武斷|爛|白痴|垃圾|你不懂/.test(text)) {
    next.defensiveness += 0.2;
    next.annoyance += 0.2;
  }
  if (/[?？]/.test(text)) next.curiosity += 0.08;
  if (historyLen > 20) next.tiredness += 0.1;

  for (const field of ["curiosity", "playfulness", "attachment", "defensiveness", "annoyance", "tiredness"]) {
    next[field] = clamp(next[field]);
  }

  next.updatedAt = Date.now();
  STATE_MAP.set(k, next);
  return { ...next };
}

module.exports = {
  getState,
  updateState,
};

