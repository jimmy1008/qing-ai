const AUTO_L1 = true;

function evaluateRisk(actionProposal) {
  if (!actionProposal) return { allowed: false, reason: "no_action" };

  const { risk_level: riskLevel } = actionProposal;

  if (riskLevel === "L0") return { allowed: true, reason: "auto_l0" };
  if (riskLevel === "L1") return { allowed: AUTO_L1, reason: AUTO_L1 ? "auto_l1" : "manual_l1" };
  if (riskLevel === "L2") return { allowed: false, reason: "manual_l2" };
  if (riskLevel === "L3") return { allowed: false, reason: "manual_l3" };

  return { allowed: false, reason: "unknown_risk" };
}

module.exports = { evaluateRisk };
