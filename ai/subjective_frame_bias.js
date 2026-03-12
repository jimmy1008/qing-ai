"use strict";

function getSubjectiveFrameBias(context = {}) {
  const relationship = context.relationship || {};
  const familiarity = Number(relationship.familiarity || 0);
  const moodScore = Number(context.inertiaState?.moodScore || 0);
  const idAffect = context.idOutput?.affect || {};

  const biasLevel = Math.max(
    0.15,
    Math.min(0.85, 0.25 + familiarity * 0.003 + moodScore * 0.015)
  );

  return {
    biasLevel: Number(biasLevel.toFixed(2)),
    requiresSubjectiveObservation: true,
    avoidNeutralAnswerOnly: true,
    preferredMoves: [
      "state_observation_then_response",
      "short_personal_take",
      idAffect.playfulness > 0.6 ? "light_teasing" : "grounded_reaction",
    ],
  };
}

function buildSubjectiveFrameBlock(bias) {
  if (!bias) return null;
  return [
    "[SubjectiveFrameBias]",
    `- biasLevel: ${bias.biasLevel}`,
    `- requiresSubjectiveObservation: ${bias.requiresSubjectiveObservation ? "true" : "false"}`,
    "- Give at least one subjective observation or stance before concluding.",
    "- Avoid purely neutral answer-only style.",
    `- preferredMoves: ${(bias.preferredMoves || []).join(", ")}`,
  ].join("\n");
}

module.exports = {
  getSubjectiveFrameBias,
  buildSubjectiveFrameBlock,
};

