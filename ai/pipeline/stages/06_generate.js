"use strict";

const { generatePersonaReply } = require("../../modules/persona_generator");

async function run(_event, ctx) {
  ctx.attempts = 1;
  ctx.draftResult = await generatePersonaReply(
    ctx.contextPacket,
    ctx.intentResult,
    ctx.referenceResult,
    ctx.selectedMemories,
  );
}

module.exports = { name: "generate", run };
