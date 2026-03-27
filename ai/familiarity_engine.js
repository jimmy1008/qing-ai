const { clamp } = require("../utils/math");

// ── Role-based hard caps ──────────────────────────────────────────────────────
// owner (developer role) = 100, public_user max = 75
// Only the owner can reach 100 — no one else accumulates there naturally.
const ROLE_CAP = {
  developer:   100,
  public_user: 75,
  default:     75,
};

function getRoleCap(role) {
  return ROLE_CAP[role] || ROLE_CAP.default;
}

function clampScore(score) {
  return clamp(Number(score || 0), 0, 100);
}

function clampForRole(score, role) {
  return clamp(Number(score || 0), 0, getRoleCap(role));
}

// ── Band definitions ─────────────────────────────────────────────────────────
// L3 stranger: 0-19, L2 casual: 20-49, L2 familiar: 50-74, L1 owner: 100
function getFamiliarityBand(score) {
  const value = clampScore(score);
  if (value <= 19)  return "stranger";   // L3 — @only
  if (value <= 49)  return "casual";     // L2 low
  if (value <= 74)  return "familiar";   // L2 high
  if (value <= 99)  return "close";      // near-owner (developer only range)
  return "owner";                        // 100 = hardcoded owner
}

function getFamiliarityLevel(score, role) {
  if (role === "developer") return "L1";
  // public_user can never be L1 regardless of score
  const value = clampScore(score);
  if (value <= 19) return "L3";
  return "L2";
}

// ── Source weight ─────────────────────────────────────────────────────────────
// Base weight before diminishing returns.
function getSourceWeight(event = {}) {
  const platform    = String(event.platform || "unknown").toLowerCase();
  const channelType = String(event.channelType || event.channel || "private").toLowerCase();
  const eventType   = String(event.eventType || "message").toLowerCase();

  if (platform === "telegram" && channelType === "private") return 0.8;
  if (platform === "telegram" && channelType === "group")   return 0.3;
  if (platform.startsWith("discord") && channelType === "private") return 0.8;
  if (platform.startsWith("discord") && channelType === "group")   return 0.3;
  if (platform.startsWith("threads") && eventType === "reply") return 0.3;
  if (platform.startsWith("threads") && channelType === "feed")  return 0.05;
  return 0.1;
}

// ── Diminishing returns ───────────────────────────────────────────────────────
// The higher the current score, the harder it is to gain more.
// public_user effectively freezes at 75 cap; developer can reach 85 naturally.
function getDiminishingFactor(score, role) {
  if (role === "developer") return 1.0;  // developer gains at full rate
  if (score < 20)  return 1.0;
  if (score < 40)  return 0.5;
  if (score < 60)  return 0.2;
  if (score < 75)  return 0.05;
  return 0;  // at cap, no gain
}

// ── Meaningful interaction gate ───────────────────────────────────────────────
// Very short messages (stickers, one char) don't earn familiarity gain.
function isMeaningfulInteraction(event = {}) {
  const text = String(event.text || event.inputText || "").trim();
  return text.length >= 4;
}

// ── Decay ─────────────────────────────────────────────────────────────────────
// Applied once when a new event arrives, based on days since last interaction.
// 3-7 days: mild, 7-30 days: moderate, 30+ days: heavy.
function computeDecay(relationship = {}, now = Date.now()) {
  const lastAt = Number(relationship.lastInteractionAt || 0);
  if (!lastAt) return 0;
  const daysSince = (now - lastAt) / (24 * 60 * 60 * 1000);
  if (daysSince > 30) return -10;
  if (daysSince > 7)  return -5;
  if (daysSince > 3)  return -2;
  return 0;
}

// ── Developer floor (not ceiling) ────────────────────────────────────────────
// Developer never drops below 60 from decay.
function applyDeveloperSafeguard(score, role) {
  if (role === "developer") return Math.max(clampScore(score), 60);
  return clampScore(score);
}

// ── Main update function ──────────────────────────────────────────────────────
function updateFamiliarityFromEvent(relationship = {}, event = {}, options = {}) {
  const role    = options.role || event.role || "public_user";
  const now     = Number(event.timestamp || Date.now());
  const previous = clampForRole(relationship.familiarity || 0, role);

  // Apply decay first
  const decay = role === "developer" ? 0 : computeDecay(relationship, now);

  // Gain: only if meaningful interaction
  let gain = 0;
  if (isMeaningfulInteraction(event)) {
    const weight     = getSourceWeight(event);
    const dimFactor  = getDiminishingFactor(previous, role);
    gain = weight * dimFactor;
  }

  let next = applyDeveloperSafeguard(previous + decay + gain, role);
  next = clampForRole(next, role);

  relationship.familiarity      = next;
  relationship.familiarityScore = next;
  relationship.interactionCount = Number(relationship.interactionCount || 0) + 1;
  relationship.lastInteractionAt = now;

  return {
    previous,
    delta:  Number((decay + gain).toFixed(2)),
    gain:   Number(gain.toFixed(2)),
    decay,
    next,
    weight: isMeaningfulInteraction(event) ? getSourceWeight(event) : 0,
    band:   getFamiliarityBand(next),
    level:  getFamiliarityLevel(next, role),
  };
}

module.exports = {
  clampScore,
  clampForRole,
  getRoleCap,
  getFamiliarityBand,
  getFamiliarityLevel,
  getSourceWeight,
  getDiminishingFactor,
  applyDeveloperSafeguard,
  updateFamiliarityFromEvent,
};
