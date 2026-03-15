"use strict";

const { parseIntent } = require("../../modules/intent_parser");

async function run(_event, ctx) {
  ctx.intentResult = parseIntent(ctx.contextPacket);
  ctx.level = ctx.intentResult.routing_level;
}

module.exports = { name: "intent", run };
