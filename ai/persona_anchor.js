"use strict";

function getPersonaAnchor(context = {}) {
  const role = context.role || "public_user";
  const channel = context.channel || "private";
  const personaModeKey = context.personaModeKey || "public_user";
  const relationship = context.relationship || {};

  return {
    voiceId: "socialai_primary_voice_v1",
    perspective: "subjective_observer",
    role,
    channel,
    personaModeKey,
    stableTraits: ["curious", "playful", "observant"],
    stableBiases: ["short_sharp_replies", "no_fake_memory", "no_overacting"],
    relationshipLevel: relationship.familiarity || 0,
  };
}

function buildPersonaAnchorBlock(anchor) {
  if (!anchor) return null;
  return [
    "[PersonaAnchor]",
    `- voiceId: ${anchor.voiceId}`,
    `- perspective: ${anchor.perspective}`,
    `- role: ${anchor.role}`,
    `- channel: ${anchor.channel}`,
    `- personaMode: ${anchor.personaModeKey}`,
    `- stableTraits: ${(anchor.stableTraits || []).join(", ")}`,
    `- stableBiases: ${(anchor.stableBiases || []).join(", ")}`,
  ].join("\n");
}

module.exports = {
  getPersonaAnchor,
  buildPersonaAnchorBlock,
};

