"use strict";
// trade_reflector.js
// Uses LLM (晴的聲音) to generate trade reflections, periodic reviews,
// and optimization hypotheses based on trade journal data.
//
// All output is written in 晴's first-person voice.
// Model: qwen3:8b (think:false for speed)

const axios = require("axios");
const { enqueueLLM } = require("../../llm_queue");
const { DTFX_CORE } = require("./dtfx_core");

const OLLAMA_URL  = () => process.env.OLLAMA_URL  || "http://localhost:11434";
const LLM_MODEL   = () => process.env.LLM_MODEL   || "qwen3:8b";
const TIMEOUT_MS  = 60000;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate 晴's first-person reflection for a single completed trade.
 * @param {object} trade — trade object from trade_journal
 * @returns {Promise<string>} reflection text
 */
async function reflectOnTrade(trade) {
  const outcome = trade.result.outcome;
  const rrAchieved = trade.result.rr_achieved;
  const rrPlanned  = trade.rr_planned;

  const prompt = [
    "你是晴，一個正在學習交易的 AI。用第一人稱口語中文，寫這筆交易的反思，約 3–5 句。",
    "不要太制式，要有真實感。承認錯誤時直接說，成功時也不要過度興奮。",
    "",
    `交易對：${trade.pair}  方向：${trade.direction}`,
    `session：${trade.session || "未知"}  時框：${trade.timeframe}`,
    `入場：${trade.entry}  止損：${trade.stop}  止盈目標：${trade.target}`,
    `入場方式：${trade.entry_type}  關鍵區域：${trade.key_area}`,
    `計畫風報：${rrPlanned}:1  實際結果：${outcome}（RR ${rrAchieved ?? "N/A"}）`,
    `入場理由：${trade.reason || "（未記錄）"}`,
    "",
    `結果是 ${outcome === "win" ? "獲利" : outcome === "loss" ? "虧損" : "保本"}。`,
    "請反思：這筆交易的判斷哪裡對了？哪裡錯了？下次遇到類似情況會怎麼調整？",
  ].join("\n");

  return llmCall(prompt);
}

/**
 * Generate a periodic review after N trades.
 * @param {Array} trades — array of closed trades
 * @returns {Promise<string>} review text in 晴's voice
 */
async function periodicReview(trades) {
  if (!trades || trades.length === 0) return "目前還沒有足夠的交易資料可以回顧。";

  const wins    = trades.filter(t => t.result.outcome === "win").length;
  const losses  = trades.filter(t => t.result.outcome === "loss").length;
  const rrVals  = trades.map(t => t.result.rr_achieved).filter(r => r != null);
  const avgRR   = rrVals.length ? (rrVals.reduce((a,b)=>a+b,0)/rrVals.length).toFixed(2) : "N/A";

  const tradeList = trades.slice(-20).map((t, i) =>
    `${i+1}. ${t.pair} ${t.direction} [${t.session}] ${t.result.outcome} RR:${t.result.rr_achieved ?? "-"} (${t.entry_type})`
  ).join("\n");

  const prompt = [
    "你是晴，正在做交易策略回顧。用第一人稱口語中文，約 5–8 句。",
    "分析這段時間的交易表現，找出規律，誠實說出哪裡需要改進。",
    "",
    `最近 ${trades.length} 筆交易：${wins} 勝 / ${losses} 敗  平均 RR：${avgRR}`,
    "",
    "交易清單：",
    tradeList,
    "",
    "請回顧：整體表現如何？哪個 session 表現最好？哪種入場方式最有效？有什麼地方需要改進？",
  ].join("\n");

  return llmCall(prompt);
}

/**
 * Generate optimization hypotheses based on trade data patterns.
 * @param {object} stats — from trade_journal.getStats()
 * @param {Array}  trades — recent closed trades
 * @returns {Promise<string>} hypotheses in 晴's voice
 */
async function generateHypothesis(stats, trades) {
  if (!trades || trades.length < 5) return "還需要更多交易資料才能提出有意義的假設。";

  // Find best/worst patterns
  const sessionStats  = Object.entries(stats.bySession || {})
    .sort((a,b) => (b[1].winRate||0) - (a[1].winRate||0));
  const entryStats    = Object.entries(stats.byEntryType || {})
    .sort((a,b) => (b[1].winRate||0) - (a[1].winRate||0));

  const prompt = [
    "你是晴，根據自己的交易資料提出策略優化假設。用第一人稱，約 4–6 句。",
    "提出 2–3 個具體的可測試假設，說明為什麼這麼想。語氣要像在思考，不要太制式。",
    "",
    `總計 ${stats.total} 筆交易  勝率 ${stats.winRate}%  平均 RR ${stats.avgRR}`,
    "",
    "Session 表現：",
    sessionStats.map(([s, d]) => `  ${s}: 勝率 ${d.winRate}%  平均 RR ${d.avgRR}  (${d.total} 筆)`).join("\n"),
    "",
    "入場方式表現：",
    entryStats.map(([e, d]) => `  ${e}: 勝率 ${d.winRate}%  平均 RR ${d.avgRR}  (${d.total} 筆)`).join("\n"),
    "",
    "DTFX 可調整方向：",
    DTFX_CORE.optimization_surface.map(o => `  · ${o}`).join("\n"),
    "",
    "根據以上資料，提出你的優化假設。",
  ].join("\n");

  return llmCall(prompt);
}

/**
 * Generate 晴's pre-trade analysis (before entering).
 * Used when a setup is identified but not yet executed.
 * @param {object} setup — partial trade data
 * @returns {Promise<string>} analysis text
 */
async function analyzeSetup(setup) {
  const { DTFX_CORE: core } = require("./dtfx_core");
  const sessionInfo = core.sessions[setup.session] || {};

  const prompt = [
    "你是晴，正在分析一個可能的交易機會。用第一人稱，約 3–5 句，像在思考一樣。",
    "評估這個 setup 的優缺點，說明你是否想進場，以及入場的顧慮。",
    "",
    `交易對：${setup.pair}  方向：${setup.direction}  Session：${setup.session}`,
    `目前市場結構：${setup.structure || "未描述"}`,
    `關鍵區域：${setup.key_area || "未描述"}`,
    `計畫入場方式：${setup.entry_type || "未定"}`,
    `計畫入場：${setup.entry}  止損：${setup.stop}  目標：${setup.target}`,
    `計畫風報：${setup.rr_planned || "?"}:1`,
    sessionInfo.dtfx_suitability ? `\nSession 適合度：${sessionInfo.dtfx_suitability}` : "",
    "",
    "這個 setup 符合 DTFX 條件嗎？你的判斷是什麼？",
  ].join("\n");

  return llmCall(prompt);
}

/**
 * Generate 晴's learning insight from recent observation history.
 * Looks for correlations between RSI/KDJ indicator states and DTFX setup quality.
 * KDJ/RSI are reference only — DTFX score is the sole open-position criterion.
 * @param {Array} observations — recent _history entries from trading_scheduler
 * @returns {Promise<string>} insight in 晴's voice
 */
async function generateObservationInsight(observations) {
  if (!observations || observations.length < 5) return "（觀察樣本不足，無法生成學習洞察）";

  const recent      = observations.slice(-30);
  const highQuality = recent.filter(o => (o.score || 0) >= 60);
  const lowQuality  = recent.filter(o => (o.score || 0) < 45);

  const formatObs = arr => arr.slice(-8).map(o => {
    const parts = [`score=${o.score}`, `grade=${o.grade}`, `bias=${o.bias}`, `RR≈${o.rr ?? "?"}`];
    if (o.rsi  != null)          parts.push(`RSI=${o.rsi}`);
    if (o.kdj?.k != null)        parts.push(`KDJ(K=${o.kdj.k} D=${o.kdj.d} J=${o.kdj.j})`);
    return parts.join(" ");
  }).join("\n");

  const prompt = [
    "你是晴，正在從自己的看盤觀察記錄中學習，尋找指標模式和 DTFX 結構品質之間的關聯。",
    "用第一人稱，約 3–5 句。語氣像在自言自語地思考，不要給確定性結論。",
    "特別注意：RSI 和 KDJ 只是輔助指標，不能作為開倉標準。你的開倉是由 DTFX 評分決定的。",
    "如果看不出規律，直接說看不出來。",
    "",
    `最近 ${recent.length} 次觀察中，高品質 setup（score ≥ 60）共 ${highQuality.length} 次，低品質（score < 45）共 ${lowQuality.length} 次。`,
    "",
    highQuality.length > 0 ? `高品質 setup 時的指標狀態：\n${formatObs(highQuality)}` : "",
    lowQuality.length > 0  ? `\n低品質 setup 時的指標狀態：\n${formatObs(lowQuality)}`  : "",
    "",
    "你觀察到指標狀態和 DTFX setup 品質之間有什麼規律嗎？對你下次看盤有沒有參考價值？",
  ].filter(Boolean).join("\n");

  return llmCall(prompt);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function llmCall(prompt) {
  try {
    // priority 3 — background; conversation calls (priority 1) go first
    const resp = await enqueueLLM(() => axios.post(`${OLLAMA_URL()}/api/chat`, {
      model:  LLM_MODEL(),
      stream: false,
      think:  false,
      messages: [{ role: "user", content: prompt }],
    }, { timeout: TIMEOUT_MS }), 3, "background");

    const text = String(resp.data?.message?.content || "").trim();
    return text || "（無法生成反思，請稍後再試）";
  } catch (err) {
    return `（反思生成失敗：${err.message}）`;
  }
}

module.exports = { reflectOnTrade, periodicReview, generateHypothesis, analyzeSetup, generateObservationInsight };
