"use strict";

const { generatePersonaReply } = require("../../modules/persona_generator");
const { judgeResponse } = require("../../modules/response_judge");

const MAX_RETRY = 2;

async function run(_event, ctx) {
  let draftResult = ctx.draftResult;
  let judgeResult = judgeResponse(
    draftResult,
    ctx.contextPacket,
    ctx.intentResult,
    ctx.referenceResult,
  );

  while (!judgeResult.pass && ctx.attempts < MAX_RETRY) {
    draftResult = await generatePersonaReply(
      ctx.contextPacket,
      ctx.intentResult,
      ctx.referenceResult,
      ctx.selectedMemories,
    );
    judgeResult = judgeResponse(
      draftResult,
      ctx.contextPacket,
      ctx.intentResult,
      ctx.referenceResult,
    );
    ctx.attempts += 1;
  }

  ctx.draftResult = draftResult;
  ctx.judgeResult = judgeResult;
  ctx.finalText = judgeResult.fixed_text || draftResult.draft_text;
  ctx.repairAction = "none";
}

module.exports = { name: "judge", run };
