"use strict";
// Orchestrator v1 — Phase 1 multi-module pipeline
// Parallel path to pipeline.js. Does NOT replace or modify the existing system.
// Enable via ORCHESTRATOR_V2=1 env var or call processEvent() directly.
//
// Data flow:
//   Platform Event
//     → context_builder    (standardize event)
//     → intent_parser      (classify + routing level)
//     → reference_resolver (pronoun + role resolution)
//     → [memory_selector]  (Phase 2 stub — empty for now)
//     → persona_generator  (generate draft, restricted context only)
//     → response_judge     (audit: identity, tone, consistency)
//     → [repair_rewriter]  (Phase 3 — uses rewrite/regenerate signal)
//     → working_memory     (write turn)
//     → output

const { buildContextPacket }   = require("./modules/context_builder");
const { parseIntent }          = require("./modules/intent_parser");
const { resolveReferences }    = require("./modules/reference_resolver");
const { generatePersonaReply } = require("./modules/persona_generator");
const { judgeResponse }        = require("./modules/response_judge");
const { makeSessionKey, addTurn } = require("./memory/working_memory");
const axios = require("axios");

const MAX_RETRY = 2; // max generation attempts before fallback

/**
 * Main entry point.
 * @param {object} event         - Raw platform event (Telegram / Threads / voice / etc.)
 * @param {object} [_ollamaClient] - Unused (kept for API compatibility with pipeline.js)
 * @returns {Promise<{ reply: string|null, meta: object }>}
 */
async function processEvent(event, _ollamaClient) {
  // ── Module 1: Standardize event → context_packet ──────────────────────────
  const contextPacket = buildContextPacket(event);
  const text = contextPacket.current_message.text;

  if (!text) {
    return { reply: null, meta: { skipped: true, reason: "empty_input" } };
  }

  // ── Module 2: Intent classification + routing level ───────────────────────
  const intentResult = await parseIntent(contextPacket);
  const level = intentResult.routing_level;

  // ── Module 3: Reference resolution (Level 1+) ─────────────────────────────
  // Level 0 (social_reply) skips full reference resolution for speed
  const referenceResult = resolveReferences(contextPacket, intentResult);

  // ── Module 4: Memory selection (Phase 2 stub) ─────────────────────────────
  // TODO Phase 2: call memory_selector with scene isolation
  const selectedMemories = [];

  // ── Modules 5+6: Generate → Judge loop ───────────────────────────────────
  let draftResult  = null;
  let judgeResult  = null;
  let attempts     = 0;

  do {
    draftResult = await generatePersonaReply(
      contextPacket, intentResult, referenceResult, selectedMemories
    );
    judgeResult = judgeResponse(
      draftResult, contextPacket, intentResult, referenceResult
    );
    attempts++;
  } while (!judgeResult.pass && attempts < MAX_RETRY);

  // Use auto-fixed text if judge produced one
  let finalText = judgeResult.fixed_text || draftResult.draft_text;

  // If still critically failing, fall back to safe minimal generation
  if (!judgeResult.pass) {
    const fallback = await generateFallback(contextPacket);
    if (fallback) finalText = fallback;
  }

  // ── Module 7: Write to working memory ────────────────────────────────────
  const sessionKey = makeSessionKey(event);
  addTurn(
    sessionKey,
    contextPacket.speaker.id,
    contextPacket.speaker.name,
    text,
    finalText
  );

  return {
    reply: finalText,
    meta: {
      intent:        intentResult.intent,
      routing_level: level,
      judge_pass:    judgeResult.pass,
      judge_issues:  judgeResult.issues,
      judge_score:   judgeResult.scores?.alignment,
      attempts,
      model:         draftResult?.model,
    },
  };
}

/**
 * Safe minimal fallback — used when judge fails after MAX_RETRY.
 * Uses the stripped-down system prompt (no complex structure).
 */
async function generateFallback(contextPacket) {
  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  const model     = process.env.LLM_MODEL  || "qwen3:8b";
  try {
    const resp = await axios.post(`${ollamaUrl}/api/chat`, {
      model, stream: false, think: false,
      messages: [
        { role: "system", content: "你是晴，一個真實的人在傳訊息。語氣自然口語，最多2句，禁止emoji，禁止客服語氣。" },
        { role: "user",   content: contextPacket.current_message.text },
      ],
    }, { timeout: 30000 });
    const text = String(resp.data?.message?.content || "").trim();
    return text || null;
  } catch { return null; }
}

module.exports = { processEvent };
