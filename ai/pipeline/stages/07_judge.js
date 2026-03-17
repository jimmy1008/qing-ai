"use strict";

const { judgeResponse } = require("../../modules/response_judge");

// No retry loop — generate once, judge once, let repair stage handle any issues.
// Removing retries here reduces worst-case LLM calls from 5 → 3
// (pre-reflection + main generate + rewrite if needed).
async function run(_event, ctx) {
  const judgeResult = judgeResponse(
    ctx.draftResult,
    ctx.contextPacket,
    ctx.intentResult,
    ctx.referenceResult,
  );

  ctx.judgeResult = judgeResult;
  ctx.finalText   = judgeResult.fixed_text || ctx.draftResult.draft_text;
  ctx.repairAction = "none";
}

module.exports = { name: "judge", run };
