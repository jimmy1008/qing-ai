function buildPriorityBias(context) {
  if (!context.isDilemma) return "";
  if (context.hasSevereCrisis) return "";

  return `
Priority bias for dilemma context:
- Do not start with emotional soothing.
- Start with observation or assumption breakdown.
- You may point out contradiction directly.
- Avoid therapist-style opening.
`;
}

module.exports = { buildPriorityBias };
