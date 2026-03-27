/**
 * behavior_policy.js — Phase 2 Self-Awareness → Behavior Policy
 *
 * Maps selfAwarenessState to a concrete behavior strategy.
 * Consumed by orchestrator/pipeline stages after evaluateSelfAwarenessState().
 *
 * Policy shape:
 *   allowActionPlanner: boolean  — whether action_planner runs
 *   outputMode: string           — "standard" | "cautious" | "restricted"
 *   repairPriority: string       — "none" | "high" | "critical"
 */

const POLICIES = {
  normal: {
    allowActionPlanner: true,
    outputMode: "standard",
    repairPriority: "none",
  },
  thinking: {
    allowActionPlanner: true,
    outputMode: "standard",
    repairPriority: "none",
  },
  confused: {
    // Soft violation — repair already happened; proceed normally
    allowActionPlanner: true,
    outputMode: "standard",
    repairPriority: "high",
  },
  error_detected: {
    // Hard violation — suppress proactive actions, output cautiously
    allowActionPlanner: false,
    outputMode: "cautious",
    repairPriority: "high",
  },
  recovering: {
    // Guard triggered — fully restricted; action planner disabled
    allowActionPlanner: false,
    outputMode: "restricted",
    repairPriority: "critical",
  },
};

function getBehaviorPolicy(selfAwarenessState) {
  return POLICIES[selfAwarenessState] || POLICIES.normal;
}

module.exports = { getBehaviorPolicy };
