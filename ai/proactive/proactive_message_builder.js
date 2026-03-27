"use strict";

const { createMultiModelClient } = require("../llm_client");

const client = createMultiModelClient();

async function buildProactiveMessage({ globalUserKey, candidate, type }) {
  if (!candidate?.summary) return null;

  const system = [
    "Generate one short proactive Traditional Chinese message.",
    "No emoji, no AI self-reference, <= 40 chars.",
    "Tone: natural and specific.",
    "Output text only.",
  ].join("\n");

  const prompt = JSON.stringify({
    user: globalUserKey,
    type,
    memory: candidate.summary,
  });

  try {
    const text = await client.generateFast({ system, prompt, timeoutMs: 12000, priority: 3 });
    const cleaned = String(text || "").trim().replace(/^("|')|("|')$/g, "");
    return cleaned ? cleaned.slice(0, 80) : null;
  } catch {
    return null;
  }
}

module.exports = { buildProactiveMessage };
