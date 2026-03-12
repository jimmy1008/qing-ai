const { clamp } = require("../utils/math");

function clampScore(score) {
  return clamp(Number(score || 0), 0, 100);
}

function getFamiliarityBand(score) {
  const value = clampScore(score);
  if (value <= 9) return "stranger";
  if (value <= 39) return "casual";
  if (value <= 69) return "familiar";
  return "close";
}

function getSourceWeight(event = {}) {
  const platform = String(event.platform || "unknown").toLowerCase();
  const channelType = String(event.channelType || event.channel || "private").toLowerCase();
  const eventType = String(event.eventType || "message").toLowerCase();

  if (platform === "telegram" && channelType === "private") return 1.0;
  if (platform === "telegram" && channelType === "group") return 0.6;
  if (platform.startsWith("threads") && eventType === "reply") return 0.5;
  if (platform.startsWith("threads") && channelType === "feed") return 0.1;
  return 0.2;
}

function applyDeveloperSafeguard(score, role) {
  if (role === "developer") {
    return Math.max(clampScore(score), 60);
  }
  return clampScore(score);
}

/**
 * Compute time-based decay since last interaction.
 * Applied on every incoming event so inactive users naturally lose familiarity.
 */
function computeDecay(relationship = {}, now = Date.now()) {
  const lastAt = Number(relationship.lastInteractionAt || 0);
  if (!lastAt) return 0;
  const daysSince = (now - lastAt) / (24 * 60 * 60 * 1000);
  if (daysSince > 30) return -5;
  if (daysSince > 14) return -3;
  if (daysSince > 3) return -1;
  return 0;
}

function updateFamiliarityFromEvent(relationship = {}, event = {}, options = {}) {
  const role = options.role || event.role || "public_user";
  const developerAffinityMultiplier = Number(options.developerAffinityMultiplier || 1.35);
  const now = Number(event.timestamp || Date.now());
  const previous = clampScore(relationship.familiarity || 0);
  const weight = getSourceWeight(event);

  let delta = role === "developer"
    ? weight * developerAffinityMultiplier
    : weight;

  // Apply time-based decay before adding this event's contribution
  if (role !== "developer") {
    delta += computeDecay(relationship, now);
  }

  const next = applyDeveloperSafeguard(previous + delta, role);

  relationship.familiarity = next;
  relationship.familiarityScore = next;
  relationship.interactionCount = Number(relationship.interactionCount || 0) + 1;
  relationship.lastInteractionAt = now;

  return {
    previous,
    delta: Number(delta.toFixed(2)),
    next,
    weight,
    band: getFamiliarityBand(next),
  };
}

module.exports = {
  clampScore,
  getFamiliarityBand,
  getSourceWeight,
  applyDeveloperSafeguard,
  updateFamiliarityFromEvent,
};
