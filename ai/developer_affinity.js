function isEnabled() {
  return String(process.env.DEV_AFFINITY || "1").trim() !== "0";
}

function getDeveloperBias(event = {}, relationship = {}, moodState = {}) {
  if (!isEnabled()) {
    return { enabled: false, deltaMood: 0, deltaDrive: 0, initiativeBoost: 1 };
  }

  const role = event.role || "public_user";
  const channel = event.channel || "public";
  if (role !== "developer") {
    return { enabled: true, deltaMood: 0, deltaDrive: 0, initiativeBoost: 1 };
  }

  const familiarity = relationship.familiarity || 100;
  const familiarityFactor = familiarity >= 80 ? 1.2 : 1;

  if (channel === "private") {
    return {
      enabled: true,
      deltaMood: 2 * familiarityFactor,
      deltaDrive: 1.5 * familiarityFactor,
      initiativeBoost: 1.35,
      reason: "developer_private_affinity",
    };
  }

  return {
    enabled: true,
    deltaMood: 0.8 * familiarityFactor,
    deltaDrive: 0.6 * familiarityFactor,
    initiativeBoost: 1.15,
    reason: "developer_group_affinity",
  };
}

module.exports = {
  getDeveloperBias,
};
