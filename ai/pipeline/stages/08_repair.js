"use strict";

const axios = require("axios");
const { repairReply } = require("../../modules/repair_rewriter");
const { maybeWriteMemory } = require("../../modules/memory_writer");
const { makeSessionKey, addTurn } = require("../../memory/working_memory");
const { scoreAndLogDialogue } = require("../../quality/dialogue_quality_scorer");
const { isTradeCritique, maybeLearnFromCritique } = require("../../modules/trading/trade_lessons");

async function generateFallback(contextPacket) {
  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  const model = process.env.LLM_MODEL || "qwen3:8b";

  try {
    const resp = await axios.post(`${ollamaUrl}/api/chat`, {
      model,
      stream: false,
      think: false,
      messages: [
        { role: "system", content: "請用自然、簡短、口語中文回覆，不要自稱 AI。" },
        { role: "user", content: contextPacket.current_message.text },
      ],
      options: { num_ctx: 2048, num_predict: 150 },
    }, { timeout: 30000 });

    const text = String(resp.data?.message?.content || "").trim();
    return text || null;
  } catch {
    return null;
  }
}

async function run(event, ctx) {
  if (ctx.judgeResult?.recommended_action !== "pass") {
    const repairResult = await repairReply(
      ctx.draftResult,
      ctx.judgeResult,
      ctx.contextPacket,
      ctx.intentResult,
      ctx.referenceResult,
    );

    if (repairResult.fixed_text) {
      ctx.finalText = repairResult.fixed_text;
      ctx.repairAction = repairResult.action_taken;
    }
  }

  if (!ctx.finalText) {
    const fallback = await generateFallback(ctx.contextPacket);
    if (fallback) {
      ctx.finalText = fallback;
      ctx.repairAction = "emergency_fallback";
    }
  }

  const sessionKey = makeSessionKey(event);
  addTurn(
    sessionKey,
    ctx.contextPacket.speaker.id,
    ctx.contextPacket.speaker.name,
    ctx.text,
    ctx.finalText,
  );

  maybeWriteMemory(ctx.contextPacket, ctx.intentResult, ctx.finalText).catch(() => {});

  // Extract trading principle if user is critiquing 晴's execution
  if (isTradeCritique(ctx.text, ctx.intentResult?.intent)) {
    const tradeCtx = ctx.contextPacket?.meta?.open_sim_trades || ctx.contextPacket?.meta?.open_real_trades || null;
    maybeLearnFromCritique(ctx.text, tradeCtx).catch(() => {});
  }
  scoreAndLogDialogue({
    userText: ctx.text,
    replyText: ctx.finalText,
    contextMeta: {
      intent: ctx.intentResult?.intent || "unknown",
      routing_level: ctx.level,
      connector: ctx.contextPacket?.meta?.connector || null,
    },
  }).catch(() => {});

  ctx.result = {
    reply: ctx.finalText,
    chart: ctx.chartRequest || null,
    meta: {
      intent: ctx.intentResult?.intent,
      routing_level: ctx.level,
      judge_pass: ctx.judgeResult?.pass,
      judge_issues: ctx.judgeResult?.issues,
      judge_score: ctx.judgeResult?.scores?.alignment,
      repair_action: ctx.repairAction,
      memories_used: (ctx.selectedMemories || []).length,
      attempts: ctx.attempts,
      model: ctx.draftResult?.model,
    },
  };
  ctx.halt = true;
}

module.exports = { name: "repair", run };


