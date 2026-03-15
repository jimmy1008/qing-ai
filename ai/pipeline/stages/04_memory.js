"use strict";

const { selectMemories } = require("../../modules/memory_selector");

async function run(_event, ctx) {
  ctx.selectedMemories = await selectMemories(ctx.contextPacket, ctx.intentResult);
}

module.exports = { name: "memory", run };
