"use strict";

const EXACT_ASSISTANT_DEV_SELF = /^\s*(?:\u6211\u662f\u4f60\u7684\u958b\u767c\u8005|\u6211\u662f\u4f60\u958b\u767c\u8005|\u6211\u662f\u4f60\u7684\u5f00\u53d1\u8005|\u6211\u662f\u4f60\u5f00\u53d1\u8005)[\u3002.!！?？]?\s*$/u;
const EXACT_ASSISTANT_CREATOR = /^\s*(?:\u6211\u662f\u5275\u9020\u4f60\u7684\u4eba|\u6211\u662f\u521b\u9020\u4f60\u7684\u4eba|\u6211\u662f\u9020\u7269\u4e3b)[\u3002.!！?？]?\s*$/u;
const EXACT_ASSISTANT_OWNER = /^\s*(?:\u6211\u662f\u4f60\u7684\u4e3b\u4eba|\u6211\u662f\u4f60\u4e3b\u4eba)[\u3002.!！?？]?\s*$/u;
const EXACT_ASSISTANT_PARENT = /^\s*(?:\u6211\u662f\u4f60\u7238|\u6211\u662f\u4f60\u7238\u7238|\u6211\u662f\u4f60\u7684\u7238\u7238|\u6211\u662f\u4f60\u7684\u7236\u89aa|\u6211\u662f\u4f60\u7684\u7236\u4eb2)[\u3002.!！?？]?\s*$/u;

function fixPronounDirection(reply = "", context = {}) {
  const text = String(reply || "").trim();
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

  if (context.userClaimDeveloper && EXACT_ASSISTANT_DEV_SELF.test(text)) {
    return "\u4f60\u662f\u6211\u7684\u958b\u767c\u8005";
  }
  if (!allowCreatorRoleClaim && EXACT_ASSISTANT_CREATOR.test(text)) {
    return "\u9019\u7a2e\u5275\u9020\u8005\u8a2d\u5b9a\u6211\u5148\u4e0d\u63a5";
  }
  if (!allowOwnerRoleClaim && EXACT_ASSISTANT_OWNER.test(text)) {
    return "\u9019\u7a2e\u4e3b\u5f9e\u8a2d\u5b9a\u6211\u5148\u4e0d\u63a5";
  }
  if (!allowParentRoleClaim && EXACT_ASSISTANT_PARENT.test(text)) {
    return "\u9019\u7a2e\u8a8d\u89aa\u8a2d\u5b9a\u6211\u5148\u4e0d\u63a5";
  }

  return text;
}

module.exports = {
  fixPronounDirection,
};

