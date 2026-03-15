"use strict";

const STAGES = [
  require("./stages/01_context"),
  require("./stages/02_intent"),
  require("./stages/03_reference"),
  require("./stages/04_memory"),
  require("./stages/05_phase_b"),
  require("./stages/06_generate"),
  require("./stages/07_judge"),
  require("./stages/08_repair"),
];

async function runPipeline(event) {
  const ctx = {};

  for (const stage of STAGES) {
    ctx.currentStage = stage.name;
    try {
      await stage.run(event, ctx);
      if (ctx.halt) break;
    } catch (err) {
      ctx.error = err;
      break;
    }
  }

  if (ctx.error) {
    return {
      reply: null,
      meta: {
        error: ctx.error.message,
        stage: ctx.currentStage || "unknown",
      },
    };
  }

  if (ctx.result) return ctx.result;

  return {
    reply: null,
    meta: {
      skipped: true,
      reason: "no_result",
    },
  };
}

module.exports = { runPipeline };
