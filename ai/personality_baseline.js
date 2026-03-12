const PERSONALITY_BASELINE = {
  moodRecoveryHalfLifeSec: 1800,
  moodMaxDeltaPerTick: 1.5,
  initiativeCooldownSec: 2 * 60 * 60,
  initiativeCooldownDeveloperSec: 30 * 60,
  initiativeMinFamiliarity: 70,
  developerAffinityMultiplier: 1.35,
  strangerSuppression: 0.35,
  behaviorLatencyMsRange: [800, 2200],
  urgeThreshold: 12,
  urgeSatiationDrop: 5,
  urgeRecoveryPerMinute: 0.28,
  selfPauseMsRange: [10 * 60 * 1000, 30 * 60 * 1000],
};

function getPersonalityBaseline() {
  return { ...PERSONALITY_BASELINE };
}

module.exports = {
  PERSONALITY_BASELINE,
  getPersonalityBaseline,
};
