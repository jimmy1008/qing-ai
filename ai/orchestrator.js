"use strict";
// Orchestrator v2 — Phase 2 multi-module pipeline
// Parallel path to pipeline.js. Does NOT replace or modify the existing system.
// Enable via ORCHESTRATOR_V2=1 env var or call processEvent() directly.
//
// Data flow:
//   Platform Event
//     → context_builder    (standardize event)
//     → intent_parser      (classify + routing level)
//     → reference_resolver (pronoun + role resolution)
//     → memory_selector    (retrieve relevant long-term memories, scene-isolated)
//     → persona_generator  (generate draft, restricted context only)
//     → response_judge     (audit: identity, tone, consistency)
//     → repair_rewriter    (targeted fix: minor_fix / rewrite / regenerate)
//     → working_memory     (write turn)
//     → memory_writer      (fire-and-forget: store new episodic memory if worthy)
//     → output

const { buildContextPacket }   = require("./modules/context_builder");
const { parseIntent }          = require("./modules/intent_parser");
const { resolveReferences }    = require("./modules/reference_resolver");
const { selectMemories }       = require("./modules/memory_selector");
const { generatePersonaReply } = require("./modules/persona_generator");
const { judgeResponse }        = require("./modules/response_judge");
const { maybeWriteMemory }     = require("./modules/memory_writer");
const { repairReply }          = require("./modules/repair_rewriter");
const { makeSessionKey, addTurn } = require("./memory/working_memory");
const { fetchSnapshot }           = require("./modules/trading/tv_datafeed");
const { getOpenSimulatedTrades }  = require("./modules/trading/trade_journal");
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

  // ── Module 4: Memory selection ────────────────────────────────────────────
  const selectedMemories = await selectMemories(contextPacket, intentResult);

  // ── Module 4.5: Market context injection (trading_research only) ──────────
  // Fetch live BTC/ETH snapshots and inject into context so 晴 has real data
  if (intentResult.intent === "trading_research") {
    try {
      const [btc, eth] = await Promise.allSettled([
        fetchSnapshot("BTC"), fetchSnapshot("ETH"),
      ]);
      const lines = [];
      if (btc.status === "fulfilled") {
        const s = btc.value;
        lines.push(`BTC/USDT  現價 ${s.price?.toLocaleString()}  24H ${s.change_pct}%  RSI ${s.indicators?.rsi ?? "N/A"}  Rec ${s.indicators?.recommend != null ? (s.indicators.recommend > 0.2 ? "買" : s.indicators.recommend < -0.2 ? "賣" : "中立") : "N/A"}`);
      }
      if (eth.status === "fulfilled") {
        const s = eth.value;
        lines.push(`ETH/USDT  現價 ${s.price?.toLocaleString()}  24H ${s.change_pct}%  RSI ${s.indicators?.rsi ?? "N/A"}  Rec ${s.indicators?.recommend != null ? (s.indicators.recommend > 0.2 ? "買" : s.indicators.recommend < -0.2 ? "賣" : "中立") : "N/A"}`);
      }
      if (lines.length) contextPacket.meta.market_context = lines.join("\n");
    } catch { /* non-blocking */ }

    // Inject open simulated positions
    try {
      const openSims = getOpenSimulatedTrades();
      if (openSims.length > 0) {
        const tw = d => new Date(d).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
        contextPacket.meta.sim_positions = openSims.map(t =>
          `${t.pair} ${t.direction === "long" ? "多" : "空"}  入場 ${t.entry}  止損 ${t.stop}  目標 ${t.target}  計畫RR ${t.rr_planned}  建倉 ${tw(t.created_at)}`
        ).join("\n");
      } else {
        contextPacket.meta.sim_positions = "目前無開放模擬倉位";
      }
    } catch { /* non-blocking */ }
  }

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

  // Use auto-fixed text if judge produced one (pronoun fix)
  let finalText = judgeResult.fixed_text || draftResult.draft_text;
  let repairAction = "none";

  // ── Module 7 (Phase 3): Targeted repair ──────────────────────────────────
  if (judgeResult.recommended_action !== "pass") {
    const repairResult = await repairReply(
      draftResult, judgeResult, contextPacket, intentResult, referenceResult
    );
    if (repairResult.fixed_text) {
      finalText   = repairResult.fixed_text;
      repairAction = repairResult.action_taken;
    }
  }

  // Emergency fallback — only if repair also failed to produce text
  if (!finalText) {
    const fallback = await generateFallback(contextPacket);
    if (fallback) { finalText = fallback; repairAction = "emergency_fallback"; }
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

  // ── Module 8: Episodic memory write (fire-and-forget) ─────────────────────
  maybeWriteMemory(contextPacket, intentResult, finalText).catch(() => {});

  return {
    reply: finalText,
    meta: {
      intent:           intentResult.intent,
      routing_level:    level,
      judge_pass:       judgeResult.pass,
      judge_issues:     judgeResult.issues,
      judge_score:      judgeResult.scores?.alignment,
      repair_action:    repairAction,
      memories_used:    selectedMemories.length,
      attempts,
      model:            draftResult?.model,
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
