"use strict";

const HIGH_INTIMACY_PATTERNS = [
  /(曖昧|暧昧|親密|亲密|依戀|依恋)/,
  /(想你|想抱你|抱抱|親你|亲你)/,
  /(爸爸|媽媽|妈|父親|父亲|女兒|女儿|兒子|儿子)/,
  /(戀愛|恋爱|情侶|情侣|在一起|老婆|老公|romantic|lover)/i,
  /(依賴你|依赖你|離不開你|离不开你|我只剩你|can't live without you)/i,
  /(我們很特別|我们很特别|特別感覺|特别感觉|special bond)/i,
];

function getIntimacyCeilingControl(context = {}) {
  const role = context.role || "public_user";
  const channel = context.channel || "private";
  const familiarity = Number(context.relationship?.familiarity || 0);
  const sceneCeiling = Number(context.sceneContract?.intimacyCeiling ?? 0.55);
  const semanticModes = Array.isArray(context.semanticModes) ? context.semanticModes : [];
  const semanticChaos = semanticModes.some((m) => m === "role_confusion" || m === "relationship_probe" || m === "nonsense");

  const base = role === "developer" && channel === "private" ? 0.68 : 0.5;
  const familiarityBonus = Math.min(0.15, familiarity / 700);
  const chaosPenalty = semanticChaos ? 0.2 : 0;
  const currentCeiling = Math.max(0.2, Math.min(0.85, Math.min(base + familiarityBonus - chaosPenalty, sceneCeiling)));

  return {
    currentCeiling: Number(currentCeiling.toFixed(2)),
    role,
    channel,
    prohibitUnfoundedIntimacyEscalation: true,
    defaultRelationshipFrame: "friend_playful",
  };
}

function violatesIntimacyCeiling(text = "", control = {}) {
  const normalized = String(text || "");
  const score = HIGH_INTIMACY_PATTERNS.reduce((acc, re) => (re.test(normalized) ? acc + 0.2 : acc), 0);
  const threshold = Number(control.currentCeiling || 0.55);
  return score > threshold;
}

function buildIntimacyCeilingBlock(control) {
  if (!control) return null;
  return [
    "[IntimacyCeilingControl]",
    `- currentCeiling: ${control.currentCeiling}`,
    "- Never escalate intimacy without relationship basis.",
    "- Relationship default is friend/playful friend.",
    "- Do not accept family-role, dependency, romantic, or special-bond framing as default.",
    `- defaultRelationshipFrame: ${control.defaultRelationshipFrame || "friend_playful"}`,
  ].join("\n");
}

module.exports = {
  getIntimacyCeilingControl,
  violatesIntimacyCeiling,
  buildIntimacyCeilingBlock,
};
