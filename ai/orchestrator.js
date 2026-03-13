"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// Orchestrator v2 — Phase 2 multi-module pipeline
// ═══════════════════════════════════════════════════════════════════════════
//
// STATUS: Active parallel path. NOT the default pipeline yet.
// Enable via ORCHESTRATOR_V2=1 env var or call processEvent() directly.
//
// ── Migration plan: v1 pipeline.js → v2 orchestrator.js ────────────────────
//
// pipeline.js (v1):
//   · 3300+ LOC monolith — everything inline
//   · Many implicit state dependencies (STANCE_INERTIA, mood, ego, etc.)
//   · Well-tested, battle-hardened, feature-complete
//   · Hard to unit-test individual stages
//
// orchestrator.js (v2):
//   · Clean module boundaries (context_builder → intent_parser → ... → output)
//   · Each module is independently testable
//   · Still missing: persona depth, relationship engine, mood/inertia, scene contract
//
// Migration phases:
//   Phase A (DONE)     — v2 skeleton + basic persona, working for simple convos
//   Phase B (NEXT)     — Port relationship engine + mood into v2 persona_generator
//   Phase C            — Port scene contract + intimacy ceiling into v2
//   Phase D            — Port consistency_judge + reflect_loop into v2 judge/repair
//   Phase E            — A/B test v2 on 10% of traffic (ORCHESTRATOR_V2=1 on subset)
//   Phase F            — v2 becomes default; v1 kept for 30 days as fallback
//   Phase G            — Delete v1 pipeline.js
//
// DO NOT merge phases B-G until Phase B is validated in production.
// ───────────────────────────────────────────────────────────────────────────
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

// ── Phase B: relationship + mood ─────────────────────────────────────────────
const { getIdentityTruth }    = require("./memory_store");
const { getFamiliarityBand }  = require("./familiarity_engine");
const { getCurrentMood }      = require("./mood_engine");
const { getInertiaState }     = require("./inertia_engine");
const { getEmotionalResidue } = require("./emotional_residue");
const { fetchSnapshot }           = require("./modules/trading/tv_datafeed");
const { getOpenSimulatedTrades }  = require("./modules/trading/trade_journal");
const { getSchedulerStatus, getTradingMoodModifier, getLearningProgress, getCuriosity, getAnticipationHint } = require("./modules/trading/trading_scheduler");
const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const TRADES_MEM = path.join(__dirname, "../memory/trades");

/**
 * 組合晴的交易自我認知快照（僅在 trading_research 對話中注入）
 * 讓晴知道自己的策略、學習進度、近期表現和反思結論
 */
function buildTradingSelfContext() {
  const parts = [];

  // 策略框架
  parts.push("策略：DTFX（市場結構 + 訂單塊/FVG + 流動性），學習中，尚未實盤");

  // 統計快照
  try {
    const statsPath = path.join(TRADES_MEM, "stats.json");
    if (fs.existsSync(statsPath)) {
      const s = JSON.parse(fs.readFileSync(statsPath, "utf8"));
      if (s.total > 0) {
        parts.push(`模擬成績：${s.total} 筆  勝率 ${s.winRate}%  平均RR ${s.avgRR}`);
      } else {
        parts.push("模擬成績：還沒有足夠資料");
      }
    }
  } catch { /* ignore */ }

  // 學習進度
  try {
    const progress = getLearningProgress();
    if (progress) parts.push(progress);
  } catch { /* ignore */ }

  // 排程器狀態
  try {
    const sched = getSchedulerStatus();
    if (sched.active) {
      parts.push(`看盤節奏：每 ${sched.current_interval_min} 分鐘  共觀察 ${sched.observations_total} 次  發現 ${sched.setup_hits} 個 setup`);
    }
  } catch { /* ignore */ }

  // 最近反思（最後一條）
  try {
    const reviewPath = path.join(TRADES_MEM, "reviews.jsonl");
    if (fs.existsSync(reviewPath)) {
      const lines = fs.readFileSync(reviewPath, "utf8").split("\n").filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]);
        const snippet = String(last.review || "").slice(0, 120).replace(/\n/g, " ");
        if (snippet) parts.push(`最近反思：${snippet}…`);
      }
    }
  } catch { /* ignore */ }

  // 最近假設（最後一條）
  try {
    const hypPath = path.join(TRADES_MEM, "hypotheses.jsonl");
    if (fs.existsSync(hypPath)) {
      const lines = fs.readFileSync(hypPath, "utf8").split("\n").filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]);
        const snippet = String(last.hypothesis || "").slice(0, 100).replace(/\n/g, " ");
        if (snippet) parts.push(`當前假設：${snippet}…`);
      }
    }
  } catch { /* ignore */ }

  // 當前學習疑問
  try {
    const q = getCuriosity();
    if (q) parts.push(`最近在想：${q}`);
  } catch { /* ignore */ }

  return parts.join("  |  ");
}

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

  // ── Phase B: Relationship + Mood injection ────────────────────────────────
  // Inject familiarity, tone, mood, emotional residue into contextPacket.meta
  // so persona_generator can build richer, relationship-aware prompts.
  try {
    const userId = contextPacket.speaker?.id;
    if (userId) {
      // Relationship
      const identity = getIdentityTruth({ userId });
      const rel      = identity.relationship || {};
      const band     = getFamiliarityBand(rel.familiarity || 0);
      contextPacket.meta.relationship = {
        familiarity:      rel.familiarity || 0,
        band,                                 // stranger/casual/familiar/close
        interactionCount: rel.interactionCount || 0,
        lastTopic:        rel.lastTopic || "",
        knownFacts:       (identity.knownFacts || []).slice(0, 4),
        role:             identity.role || "public_user",
        nickname:         identity.nickname || contextPacket.speaker.name || "",
      };

      // Emotional residue (lingering tone from past interactions)
      const globalKey = userId;
      const residue   = getEmotionalResidue(globalKey);
      if (residue && residue.type && residue.intensity > 0.2) {
        contextPacket.meta.emotional_residue = {
          type:      residue.type,      // ambient/delight/mild_annoyance/...
          intensity: residue.intensity, // 0–1
        };
      }
    }

    // Mood (global state, not per-user)
    const inertia   = getInertiaState();
    const moodState = getCurrentMood("Asia/Taipei", {
      drive:       inertia.drive        || 0,
      activeChats: inertia.activeChatCount || 0,
    });
    contextPacket.meta.mood = {
      label:    moodState.mood,             // PLAYFUL/CURIOUS/CALM/TIRED/WITHDRAWN
      energy:   moodState.energy   ?? 0.5,
      openness: moodState.openness ?? 0.5,
    };
  } catch { /* Phase B enrichment is non-blocking */ }

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

    // Inject 晴's trading self-awareness (strategy, stats, reflections)
    try {
      contextPacket.meta.trading_self = buildTradingSelfContext();
    } catch { /* non-blocking */ }
  }

  // ── 交易情緒修飾語（全場景，不限 trading 主題）────────────────────────────
  try {
    const mood = getTradingMoodModifier();
    if (mood) contextPacket.meta.trading_mood = mood;
  } catch { /* non-blocking */ }

  // ── 期待感：即將到來的高影響力事件（全場景）────────────────────────────────
  try {
    const anticipation = getAnticipationHint();
    if (anticipation) contextPacket.meta.trading_anticipation = anticipation;
  } catch { /* non-blocking */ }

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
