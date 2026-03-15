"use strict";

const { runPipeline } = require("./pipeline/runner");

async function processEvent(event, _ollamaClient) {
  return runPipeline(event);
}

module.exports = { processEvent };
