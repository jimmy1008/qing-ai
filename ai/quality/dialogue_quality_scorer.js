"use strict";

const path = require("path");
const { createMultiModelClient } = require("../llm_client");
const { appendLine } = require("../memory_service");

const client = createMultiModelClient();
const QUALITY_LOG_PATH = path.join(__dirname, "../../telemetry/dialogue_quality.jsonl");

function parseJson(raw) {
  const text = String(raw || "");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function scoreDialogue({ userText, replyText, contextMeta = {} }) {
  if (!userText || !replyText) {
    return {
      naturalness: 0,
      consistency: 0,
      information: 0,
      overall: 0,
      flags: ["empty_input"],
    };
  }

  const system = [
    "Score dialogue quality in JSON only.",
    "Dimensions 0-10: naturalness, consistency, information.",
    "Return JSON: {naturalness, consistency, information, flags:[...]}",
  ].join("\n");

  const prompt = JSON.stringify({ userText, replyText, contextMeta });

  let scored = null;
  try {
    const raw = await client.generateFast({ system, prompt, timeoutMs: 10000, priority: 2 });
    scored = parseJson(raw);
  } catch {
    scored = null;
  }

  const naturalness = Math.max(0, Math.min(10, Number(scored?.naturalness ?? 0)));
  const consistency = Math.max(0, Math.min(10, Number(scored?.consistency ?? 0)));
  const information = Math.max(0, Math.min(10, Number(scored?.information ?? 0)));
  const overall = Number((naturalness * 0.4 + consistency * 0.35 + information * 0.25).toFixed(2));
  const flags = Array.isArray(scored?.flags) ? scored.flags.map((x) => String(x)) : [];

  return { naturalness, consistency, information, overall, flags };
}

function logDialogueQuality(entry = {}) {
  return appendLine(QUALITY_LOG_PATH, JSON.stringify({ ts: Date.now(), ...entry })).catch(() => {});
}

async function scoreAndLogDialogue(payload) {
  const score = await scoreDialogue(payload);
  await logDialogueQuality({ ...payload, score });
  return score;
}

module.exports = {
  scoreDialogue,
  logDialogueQuality,
  scoreAndLogDialogue,
};
