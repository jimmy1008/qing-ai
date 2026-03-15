"use strict";

const { buildContextPacket } = require("../../modules/context_builder");

async function run(event, ctx) {
  const contextPacket = buildContextPacket(event);
  const text = contextPacket.current_message.text;

  ctx.contextPacket = contextPacket;
  ctx.text = text;

  if (!text) {
    ctx.result = {
      reply: null,
      meta: {
        skipped: true,
        reason: "empty_input",
      },
    };
    ctx.halt = true;
  }
}

module.exports = { name: "context", run };
