/**
 * self_awareness.js — Error Reaction / Self-Awareness State
 *
 * Maps the AI's internal consistency/reflect results into a human-readable
 * self-awareness state and error severity level.
 *
 * States: normal | thinking | confused | error_detected | recovering
 * Severity: 0 (none) | 1 (minor) | 2 (medium) | 3 (critical)
 *
 * This module is pure — no side effects, no I/O.
 * It is consumed by pipeline.js telemetry and bot.js logs.
 */

// Hard-lock reason codes that indicate critical behavior deviation
const HARD_LOCK_REASONS = new Set([
  "question_detected",
  "emoji_detected",
  "filler_tone_detected",
]);

// Persona/behavior anomaly reasons added by consistency_judge behavior_anomaly checks
const ANOMALY_REASONS = new Set([
  "behavior_anomaly",
  "persona_violation",
  "logic_conflict",
  "context_mismatch",
  "action_risk",
]);

/**
 * Determine error severity from consistency judge output.
 *
 * Level 0 — no issue
 * Level 1 — minor (soft pattern violations, style drift)
 * Level 2 — medium (hard-lock violations, behavior anomaly)
 * Level 3 — critical (conversation_guard triggered / action_risk)
 */
function evaluateErrorSeverity(consistency, guardTriggered = false) {
  if (guardTriggered) return 3;
  if (!consistency || consistency.ok) return 0;

  const reasons = consistency.reasons || [];
  if (reasons.some((r) => ANOMALY_REASONS.has(r)) || reasons.includes("action_risk")) {
    return 3;
  }
  if (reasons.some((r) => HARD_LOCK_REASONS.has(r))) {
    return 2;
  }
  // Soft violations (too_long, assistant_fallback, poetic_tone, etc.)
  return 1;
}

/**
 * Map severity + reflex state into a self-awareness state string.
 *
 * @param {object} consistency   - Output of judgeConsistency()
 * @param {object} gatedTelemetry - Telemetry from applyReflexGate (reflexTriggered, reflexPassed)
 * @param {boolean} guardTriggered - Whether conversation_guard fired
 * @returns {{ state: string, errorSeverity: number }}
 */
function evaluateSelfAwarenessState(consistency, gatedTelemetry = {}, guardTriggered = false) {
  const errorSeverity = evaluateErrorSeverity(consistency, guardTriggered);

  if (guardTriggered || errorSeverity === 3) {
    return { state: "recovering", errorSeverity };
  }

  if (errorSeverity === 2) {
    return { state: "error_detected", errorSeverity };
  }

  if (errorSeverity === 1) {
    return { state: "confused", errorSeverity };
  }

  // No consistency issues — check if reflex loop was active
  if (gatedTelemetry.reflexTriggered) {
    return { state: "thinking", errorSeverity: 0 };
  }

  return { state: "normal", errorSeverity: 0 };
}

module.exports = { evaluateSelfAwarenessState, evaluateErrorSeverity };
