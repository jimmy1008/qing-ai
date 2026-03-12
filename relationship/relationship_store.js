function touchRelationship(identityMemory) {
  if (!identityMemory.relationship) {
    identityMemory.relationship = {
      interactionCount: 0,
      lastInteractionAt: null,
      familiarityScore: 0,
      familiarityProgress: 0,
      bondType: "normal",
      bondStrength: 0.2,
    };
  }

  if (identityMemory.longTerm?.role === "developer") {
    identityMemory.relationship.bondType = "primary";
    identityMemory.relationship.bondStrength = 0.9;
  } else {
    identityMemory.relationship.bondType = identityMemory.relationship.bondType || "normal";
    identityMemory.relationship.bondStrength = identityMemory.relationship.bondStrength ?? 0.2;
  }

  identityMemory.relationship.interactionCount += 1;
  identityMemory.relationship.lastInteractionAt = Date.now();

  const increment = identityMemory.relationship.bondType === "primary" ? 0.03 : 0.01;
  identityMemory.relationship.familiarityProgress =
    (identityMemory.relationship.familiarityProgress || 0) + increment;

  const progress = identityMemory.relationship.familiarityProgress || 0;
  let familiarityScore = 0;

  if (progress > 1.0) familiarityScore = 3;
  else if (progress > 0.3) familiarityScore = 2;
  else if (progress > 0.1) familiarityScore = 1;

  identityMemory.relationship.familiarityScore = familiarityScore;
  return identityMemory.relationship;
}

function getToneStyle(identityMemory) {
  const familiarityScore = identityMemory?.relationship?.familiarityScore || 0;
  if (familiarityScore >= 3) return "intimate_playful";
  if (familiarityScore >= 2) return "warm_relaxed";
  return "default";
}

module.exports = {
  touchRelationship,
  getToneStyle,
};
