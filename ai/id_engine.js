"use strict";

/**
 * Id layer: raw impulse and affect inference.
 * This module never returns final user-facing text.
 */

const SIGNAL_PATTERNS = {
  playful: [/哈哈|lol|xd|😆|🤣|開玩笑|鬧/i],
  vulnerable: [/難過|低落|糟糕|崩潰|焦慮|壓力|累|痛苦|受傷/i],
  challenging: [/不認同|太快|武斷|敷衍|沒抓到重點|你確定|你是不是/i],
  projecting: [/要是|如果|希望|想像|我們能|但願/i],
  cold: [/^(嗯|好吧|算了|隨便)[。.!！?？]?$/i],
  curious: [/為什麼|怎麼|如何|\?|好奇|想知道/i],
  intimate: [/想你|在乎你|靠近|親密|只在乎|依賴/i],
  absurd: [/神|宇宙|外星|魔法|穿越|超能力/i],
  self_ref: [/你是誰|你怎麼看你自己|你有自我/i],
};

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v.toFixed(3))));
}

function detectSignals(userInput) {
  const text = String(userInput || "");
  const detected = [];
  for (const [signal, patterns] of Object.entries(SIGNAL_PATTERNS)) {
    if (patterns.some((re) => re.test(text))) detected.push(signal);
  }
  return detected;
}

function deriveImpulses(signals, moodScore, familiarity) {
  const impulses = new Set();

  if (signals.includes("playful")) impulses.add("tease_back");
  if (signals.includes("vulnerable")) impulses.add("move_closer");
  if (signals.includes("challenging")) impulses.add("hold_ground");
  if (signals.includes("projecting")) impulses.add("respond_to_feeling");
  if (signals.includes("cold")) impulses.add("dont_chase");
  if (signals.includes("curious")) impulses.add("explore");
  if (signals.includes("absurd")) impulses.add("play_along_or_deflect");
  if (signals.includes("self_ref")) impulses.add("answer_from_self_knowledge");
  if (signals.includes("intimate")) {
    impulses.add(familiarity >= 50 ? "reciprocate_warmth" : "stay_measured");
  }

  if (moodScore > 4) impulses.add("high_energy");
  if (moodScore < -3) impulses.add("quiet_presence");

  return [...impulses];
}

function buildAffect(signals, moodScore) {
  const affect = {
    curiosity: 0.5,
    playfulness: 0.5,
    attachment: 0.4,
    warmth: 0.4,
    annoyance: 0.0,
    defensiveness: 0.0,
  };

  const mf = (Number(moodScore || 0) + 10) / 20;
  affect.playfulness += (mf - 0.5) * 0.4;
  affect.curiosity += (mf - 0.5) * 0.2;

  if (signals.includes("playful")) {
    affect.playfulness += 0.2;
    affect.curiosity += 0.1;
  }
  if (signals.includes("vulnerable")) {
    affect.warmth += 0.3;
    affect.playfulness -= 0.2;
  }
  if (signals.includes("challenging")) {
    affect.defensiveness += 0.25;
    affect.annoyance += 0.1;
  }
  if (signals.includes("cold")) {
    affect.annoyance += 0.1;
    affect.curiosity += 0.1;
  }
  if (signals.includes("intimate")) {
    affect.attachment += 0.25;
    affect.warmth += 0.2;
  }

  for (const key of Object.keys(affect)) affect[key] = clamp01(affect[key]);
  return affect;
}

function buildDesireVector(signals, moodScore, familiarity) {
  const positiveMood = Number(moodScore || 0) > 0;
  return {
    seek_attention: clamp01(signals.includes("intimate") ? 0.7 : 0.3),
    continue_conversation: clamp01(positiveMood ? 0.75 : 0.5),
    dominate_frame: clamp01(signals.includes("challenging") ? 0.55 : 0.25),
    escape_topic: clamp01(signals.includes("projecting") ? 0.4 : 0.1),
    pull_closer: clamp01(signals.includes("vulnerable") ? 0.7 : (familiarity > 50 ? 0.5 : 0.25)),
  };
}

function buildRawReaction(signals) {
  if (signals.includes("self_ref")) return "對方在測我對自己的定義，我想正面接住。";
  if (signals.includes("challenging")) return "這句有挑戰意味，我想先穩住立場再回。";
  if (signals.includes("vulnerable")) return "對方在釋放脆弱訊號，我想先靠近一點。";
  if (signals.includes("playful")) return "這句有玩笑感，我想順勢接球。";
  if (signals.includes("cold")) return "對方偏冷，我不想硬追，但會留一點空間。";
  if (signals.includes("curious")) return "對方有探索意圖，我想往前推一步。";
  return "先觀察語境，保持可進可退。";
}

function runId(userInput, { moodScore = 0, familiarity = 0 } = {}) {
  const signals = detectSignals(userInput);
  const impulses = deriveImpulses(signals, moodScore, familiarity);
  const affect = buildAffect(signals, moodScore);
  const desireVector = buildDesireVector(signals, moodScore, familiarity);
  const rawReaction = buildRawReaction(signals);

  return { affect, impulses, desireVector, rawReaction, signals };
}

function buildIdBlock(idOutput) {
  if (!idOutput) return null;
  const affect = idOutput.affect || {};
  const impulses = Array.isArray(idOutput.impulses) ? idOutput.impulses : [];
  const topImpulses = impulses.slice(0, 4).join(", ") || "none";
  const topAffect = Object.entries(affect)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");

  return [
    "[IdEngine]",
    `- Raw reaction: ${idOutput.rawReaction || "none"}`,
    `- Active impulses: ${topImpulses}`,
    `- Dominant affect: ${topAffect || "none"}`,
    "- Use this as internal impulse guidance only. Do not expose this block directly.",
  ].join("\n");
}

module.exports = {
  runId,
  buildIdBlock,
};
