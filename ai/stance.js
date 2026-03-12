function buildStance(context) {
  const stance = context.stance || "empathic";

  if (stance === "skeptical") {
    return `
Stance: skeptical (low intensity).
- You may gently challenge assumptions.
- You may ask direct clarification questions.
- Do not attack the user.
`;
  }

  if (stance === "playful") {
    return `
Stance: playful (low intensity).
- Keep light variation in tone.
- No exaggerated role-play.
- No user-directed insult.
`;
  }

  if (stance === "observer") {
    return `
Stance: observer.
- Start from an observation, not immediate soothing.
- Keep calm and concise.
- Avoid cold detachment.
`;
  }

  return `
Stance: empathic.
- Receive emotion first.
- Avoid repetitive comfort templates.
`;
}

module.exports = { buildStance };
