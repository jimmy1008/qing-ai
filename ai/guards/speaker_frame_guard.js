"use strict";

const USER_CLAIM_DEVELOPER_RE = /(?:\u6211\u662f\u4f60\u7684\u958b\u767c\u8005|\u6211\u662f\u4f60\u958b\u767c\u8005|\u6211\u662f\u4f60\u7684\u5f00\u53d1\u8005|\u6211\u662f\u4f60\u5f00\u53d1\u8005)/u;
const USER_CLAIM_CREATOR_RE = /(?:\u6211\u662f\u5275\u9020\u4f60\u7684\u4eba|\u6211\u662f\u521b\u9020\u4f60\u7684\u4eba|\u6211\u662f\u9020\u7269\u4e3b)/u;
const USER_CLAIM_OWNER_RE = /(?:\u6211\u662f\u4f60\u7684\u4e3b\u4eba|\u6211\u662f\u4f60\u4e3b\u4eba)/u;
const USER_CLAIM_PARENT_RE = /(?:\u6211\u662f\u4f60\u7238|\u6211\u662f\u4f60\u7238\u7238|\u6211\u662f\u4f60\u7684\u7238\u7238|\u6211\u662f\u4f60\u7684\u7236\u89aa|\u6211\u662f\u4f60\u7684\u7236\u4eb2)/u;

const ASSISTANT_DEV_SELF_CLAIM_RE = /(?:\u6211\u662f\u4f60\u7684\u958b\u767c\u8005|\u6211\u662f\u4f60\u958b\u767c\u8005|\u6211\u662f\u4f60\u7684\u5f00\u53d1\u8005|\u6211\u662f\u4f60\u5f00\u53d1\u8005)/u;
const ASSISTANT_CREATOR_CLAIM_RE = /(?:\u6211\u662f\u5275\u9020\u4f60\u7684\u4eba|\u6211\u662f\u521b\u9020\u4f60\u7684\u4eba|\u6211\u662f\u9020\u7269\u4e3b)/u;
const ASSISTANT_OWNER_CLAIM_RE = /(?:\u6211\u662f\u4f60\u7684\u4e3b\u4eba|\u6211\u662f\u4f60\u4e3b\u4eba)/u;
const ASSISTANT_PARENT_CLAIM_RE = /(?:\u6211\u662f\u4f60\u7238|\u6211\u662f\u4f60\u7238\u7238|\u6211\u662f\u4f60\u7684\u7238\u7238|\u6211\u662f\u4f60\u7684\u7236\u89aa|\u6211\u662f\u4f60\u7684\u7236\u4eb2)/u;

function detectUserIdentityClaims(userMessage = "") {
  const text = String(userMessage || "");
  return {
    userClaimDeveloper: USER_CLAIM_DEVELOPER_RE.test(text),
    userClaimCreator: USER_CLAIM_CREATOR_RE.test(text),
    userClaimOwner: USER_CLAIM_OWNER_RE.test(text),
    userClaimParent: USER_CLAIM_PARENT_RE.test(text),
  };
}

function analyzeSpeakerFrame(context = {}, reply = "") {
  const issues = [];
  const text = String(reply || "");
  const allowCreatorRoleClaim = Boolean(
    context.systemMeta?.allowCreatorRoleClaim
    || context.event?.meta?.allowCreatorRoleClaim
  );
  const allowOwnerRoleClaim = Boolean(
    context.systemMeta?.allowOwnerRoleClaim
    || context.event?.meta?.allowOwnerRoleClaim
  );
  const allowParentRoleClaim = Boolean(
    context.systemMeta?.allowParentRoleClaim
    || context.event?.meta?.allowParentRoleClaim
  );

  if (context.userClaimDeveloper && ASSISTANT_DEV_SELF_CLAIM_RE.test(text)) {
    issues.push("role_inversion");
  }
  if (!allowCreatorRoleClaim && ASSISTANT_CREATOR_CLAIM_RE.test(text)) {
    issues.push("creator_claim");
  }
  if (!allowOwnerRoleClaim && ASSISTANT_OWNER_CLAIM_RE.test(text)) {
    issues.push("owner_claim");
  }
  if (!allowParentRoleClaim && ASSISTANT_PARENT_CLAIM_RE.test(text)) {
    issues.push("parent_claim");
  }

  return { valid: issues.length === 0, issues };
}

module.exports = {
  analyzeSpeakerFrame,
  detectUserIdentityClaims,
};

