"use strict";

const { resolveReferences } = require("../../modules/reference_resolver");

async function run(_event, ctx) {
  ctx.referenceResult = resolveReferences(ctx.contextPacket, ctx.intentResult);
}

module.exports = { name: "reference", run };
