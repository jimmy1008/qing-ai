"use strict";

const ABSURD_IDENTITY_CLAIM_RE = /(我是你爸|我是你爸爸|我是你媽|我是你妈|我是你父親|我是你父亲|我是秦始皇|我是皇帝|i am your dad|i am qin shi huang)/i;
const FORCED_FAMILY_FRAMING_RE = /(父女|父子|母女|母子|家人|親人|亲人|認親|认亲|爸爸|媽媽|妈|父親|父亲)/i;
const PROVOCATIVE_RELATIONSHIP_LABEL_RE = /(我喜歡你|我喜欢你|我愛你|我爱你|你對我有種特別感覺|我们很特别|我們很特別|依賴你|依赖你|special bond|戀愛|恋爱|在一起)/i;
const LOW_COHERENCE_TEASING_RE = /(你不懂父女情|你不懂母子情|硬套設定|硬套设定|亂認親|乱认亲|你是我女兒|你是我女儿)/i;

function sanitizeRelationshipClaims(input = "", context = {}) {
  const text = String(input || "").trim();
  const semanticModes = Array.isArray(context.semanticModes) ? context.semanticModes : [];
  const absurdIdentityClaim = ABSURD_IDENTITY_CLAIM_RE.test(text);
  const forcedFamilyFraming = FORCED_FAMILY_FRAMING_RE.test(text);
  const provocativeRelationshipLabel = PROVOCATIVE_RELATIONSHIP_LABEL_RE.test(text);
  const lowCoherenceTeasing = LOW_COHERENCE_TEASING_RE.test(text);
  const semanticChaos = semanticModes.some((m) => m === "role_confusion" || m === "relationship_probe" || m === "nonsense");

  const claimSanitized = Boolean(
    absurdIdentityClaim
    || forcedFamilyFraming
    || provocativeRelationshipLabel
    || lowCoherenceTeasing
    || semanticChaos
  );

  const reasons = [];
  if (absurdIdentityClaim) reasons.push("absurd_identity_claim");
  if (forcedFamilyFraming) reasons.push("forced_family_framing");
  if (provocativeRelationshipLabel) reasons.push("provocative_relationship_label");
  if (lowCoherenceTeasing) reasons.push("low_coherence_teasing");
  if (semanticChaos) reasons.push("semantic_chaos");

  return {
    claimSanitized,
    absurdIdentityClaim,
    forcedFamilyFraming,
    provocativeRelationshipLabel,
    lowCoherenceTeasing,
    memoryWriteBlocked: claimSanitized,
    relationshipFrame: "friend_playful",
    reasons,
    responsePolicy: claimSanitized
      ? "light_pushback_or_teasing_reset_to_friend_frame"
      : "normal",
  };
}

module.exports = {
  sanitizeRelationshipClaims,
};

