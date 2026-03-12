"use strict";

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function getEmotionalContinuityState(context = {}) {
  const inertiaState = context.inertiaState || {};
  const moodState = context.moodState || {};
  const transition = inertiaState.transition || {};

  return {
    mood: moodState.mood || "CALM",
    moodScore: Number(inertiaState.moodScore || moodState.moodScore || 0),
    drive: Number(inertiaState.drive || 0),
    urgeToScroll: Number(inertiaState.urgeToScroll || 0),
    curiosity: clamp(0.5 + Number(inertiaState.moodScore || 0) * 0.04, 0, 1),
    playfulness: clamp(0.45 + Number(inertiaState.moodScore || 0) * 0.03, 0, 1),
    defensiveness: clamp(Number(context.idOutput?.affect?.defensiveness || 0), 0, 1),
    tiredness: clamp(0.5 - Number(inertiaState.moodScore || 0) * 0.03, 0, 1),
    transition: {
      fromMoodScore: Number(transition.fromMoodScore || 0),
      toMoodScore: Number(transition.toMoodScore || 0),
    },
  };
}

function buildEmotionalContinuityBlock(state) {
  if (!state) return null;
  return [
    "[EmotionalContinuity]",
    `- mood: ${state.mood}`,
    `- moodScore: ${state.moodScore}`,
    `- drive: ${state.drive}`,
    `- curiosity: ${state.curiosity.toFixed(2)}`,
    `- playfulness: ${state.playfulness.toFixed(2)}`,
    `- defensiveness: ${state.defensiveness.toFixed(2)}`,
    `- tiredness: ${state.tiredness.toFixed(2)}`,
    "- Preserve continuity with previous turn; do not reset to neutral unless context changes.",
  ].join("\n");
}

module.exports = {
  getEmotionalContinuityState,
  buildEmotionalContinuityBlock,
};

