"use strict";
// market_observer.js — Orchestrates full market observation cycle
//
// Flow:
//   fetchSnapshot + fetchMultiTF (TradingView)
//     → dtfx_analyzer (structural analysis per TF)
//       → buildObservationReport (structured data)
//         → LLM narrative (晴's trade idea in first person)
//           → optionally auto-log to trade_journal if setup qualifies
//
// Two observation modes:
//   observe(asset)        — full analysis + LLM commentary
//   quickSnapshot(asset)  — price snapshot only (fast, no LLM)

const axios    = require("axios");
const fs       = require("fs");
const path     = require("path");
const { fetchSnapshot, fetchMultiTF, fetchFundingOI } = require("./tv_datafeed");
const { analyzeMultiTF }                 = require("./dtfx_analyzer");

const OLLAMA_URL = () => process.env.OLLAMA_URL || "http://localhost:11434";
const LLM_MODEL  = () => process.env.LLM_MODEL  || "qwen3:8b";

// ── Observation cache — persisted to disk ─────────────────────────────────────
const OBS_FILE = path.join(__dirname, "../../../memory/trades/observations.json");

function _loadCache() {
  try {
    if (fs.existsSync(OBS_FILE)) {
      const d = JSON.parse(fs.readFileSync(OBS_FILE, "utf8"));
      return { BTC: Array.isArray(d.BTC) ? d.BTC.slice(-20) : [], ETH: Array.isArray(d.ETH) ? d.ETH.slice(-20) : [] };
    }
  } catch { /* start fresh */ }
  return { BTC: [], ETH: [] };
}

function _saveCache() {
  try {
    fs.mkdirSync(path.dirname(OBS_FILE), { recursive: true });
    fs.writeFileSync(OBS_FILE, JSON.stringify(observationCache));
  } catch { /* ignore */ }
}

const observationCache = _loadCache();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Full market observation: fetch data → analyze → LLM trade idea.
 * @param {"BTC"|"ETH"} asset
 * @param {object} opts — { noLLM: bool, params: DTFX analysis params }
 * @returns {Promise<ObservationResult>}
 */
async function observe(asset, opts = {}) {
  const A = asset.toUpperCase();
  if (A !== "BTC" && A !== "ETH") {
    throw new Error("Only BTC and ETH are supported.");
  }

  // ── Step 1: Fetch data ──────────────────────────────────────────────────
  const [snapshot, multiTF, fundingOI] = await Promise.all([
    fetchSnapshot(A).catch(err => ({ error: err.message })),
    fetchMultiTF(A).catch(err => ({ error: err.message, data: {} })),
    fetchFundingOI(A).catch(() => ({ funding_rate: null, open_interest: null })),
  ]);

  if (snapshot.error) throw new Error(`Snapshot failed: ${snapshot.error}`);

  // ── Step 2: DTFX analysis ───────────────────────────────────────────────
  const analysis = analyzeMultiTF(multiTF.data || {});

  // ── Step 3: Build structured observation report ─────────────────────────
  const report = buildReport(A, snapshot, analysis, multiTF.errors || {}, fundingOI);

  // ── Step 4: LLM trade idea narrative ────────────────────────────────────
  if (!opts.noLLM) {
    report.trade_idea = await generateTradeIdea(report);
  }

  // Cache + persist
  const cache = observationCache[A] || (observationCache[A] = []);
  cache.push({ ...report, observed_at: Date.now() });
  if (cache.length > 20) cache.splice(0, cache.length - 20);
  _saveCache();

  return report;
}

/**
 * Quick price snapshot without full analysis.
 */
async function quickSnapshot(asset) {
  const A = asset.toUpperCase();
  const snap = await fetchSnapshot(A);
  return snap;
}

/**
 * Get recent observation history.
 */
function getObservations(asset, n = 10) {
  const A = asset.toUpperCase();
  return (observationCache[A] || []).slice(-n).reverse();
}

// ── Build report ──────────────────────────────────────────────────────────────

function buildReport(asset, snapshot, analysis, dataErrors, fundingOI) {
  const conf = analysis.confluence || {};
  const h4   = analysis.timeframes?.["4H"] || {};
  const h1   = analysis.timeframes?.["1H"] || {};
  const m15  = analysis.timeframes?.["15M"] || {};

  return {
    asset,
    price:       snapshot.price,
    change_pct:  snapshot.change_pct,
    volume:      snapshot.volume,
    indicators:  snapshot.indicators,
    observed_at: Date.now(),

    // Multi-TF structure summary
    structure: {
      "4H":  h4.structure  || null,
      "1H":  h1.structure  || null,
      "15M": m15.structure || null,
    },

    // Confluence
    confluence: {
      overall_bias:    conf.overall_bias || "neutral",
      avg_setup_score: conf.avg_setup_score || 0,
      best_entry_tf:   conf.best_entry_tf || null,
      tf_biases:       conf.tf_biases || {},
      tf_scores:       conf.tf_scores || {},
    },

    // Key levels (from 1H and 15M)
    key_levels: {
      order_blocks: [...(h1.order_blocks || []), ...(m15.order_blocks || [])].slice(-3),
      fvgs:         [...(h1.fvgs || []), ...(m15.fvgs || [])].slice(-3),
      liquidity:    h1.liquidity || null,
    },

    // Latest structural events
    latest_bos:   h1.latest_bos   || null,
    latest_choch: h1.latest_choch || null,

    // Setup quality
    setup: h1.setup || null,

    // Auxiliary market data (funding rate + OI)
    auxiliary: {
      funding_rate:  fundingOI?.funding_rate  ?? null,  // % (positive = longs pay shorts)
      open_interest: fundingOI?.open_interest ?? null,  // in BTC/ETH units
      mark_price:    fundingOI?.mark_price    ?? null,
    },

    // Data quality flags
    data_errors: Object.keys(dataErrors).length ? dataErrors : null,
    trade_idea:  null,  // filled by LLM step
  };
}

// ── LLM trade idea generation ─────────────────────────────────────────────────

async function generateTradeIdea(report) {
  const bias   = report.confluence.overall_bias;
  const score  = report.confluence.avg_setup_score;
  const price  = report.price;
  const change = report.change_pct;

  // Summarize key levels for prompt
  const obList = (report.key_levels.order_blocks || [])
    .map(ob => `  · ${ob.type} ${ob.bottom}–${ob.top}`)
    .join("\n") || "  （無明確 OB）";

  const fvgList = (report.key_levels.fvgs || [])
    .map(fvg => `  · ${fvg.type} ${fvg.bottom}–${fvg.top}`)
    .join("\n") || "  （無未填 FVG）";

  const liq = report.key_levels.liquidity;
  const bslLevels = (liq?.bsl || []).map(l => l.level).join(", ") || "—";
  const sslLevels = (liq?.ssl || []).map(l => l.level).join(", ") || "—";

  const h4Trend  = report.structure["4H"]?.trend  || "?";
  const h1Trend  = report.structure["1H"]?.trend  || "?";
  const m15Trend = report.structure["15M"]?.trend || "?";

  const setupGrade = report.setup?.grade || "?";
  const setupSignals = (report.setup?.signals || []).join("; ") || "無信號";
  const setupWarnings = (report.setup?.warnings || []).join("; ") || "無";

  const rsi  = report.indicators?.rsi;
  const vol  = report.volume ? formatVolume(report.volume) : "N/A";
  const fundingRate  = report.auxiliary?.funding_rate;
  const openInterest = report.auxiliary?.open_interest;

  const prompt = [
    "你是晴，一個正在學習 DTFX 策略的 AI 交易研究員。用第一人稱口語中文，約 5–8 句。",
    "根據市場分析，說出你現在看到什麼，以及你有沒有交易想法。",
    "不要預測漲跌，不要給確定性的結論，語氣像在思考中。",
    "如果有交易想法，說出你會觀察什麼再進場，不要直接給入場價（除非結構非常清晰）。",
    "",
    `【市場現況】`,
    `${report.asset}/USDT  當前價格：${price}  24H 變化：${change}%  成交量：${vol}`,
    `RSI：${rsi ?? "N/A"}  資金費率：${fundingRate != null ? fundingRate + "%" : "N/A"}  OI：${openInterest ?? "N/A"}`,
    "",
    `【多時間框架結構】`,
    `4H：${h4Trend}  |  1H：${h1Trend}  |  15M：${m15Trend}`,
    `整體偏向：${bias}  |  Setup 評分：${score}/100（${setupGrade}級）`,
    "",
    `【關鍵區域】`,
    `Order Blocks：\n${obList}`,
    `FVG：\n${fvgList}`,
    `BSL（上方流動性）：${bslLevels}`,
    `SSL（下方流動性）：${sslLevels}`,
    "",
    `【信號】${setupSignals}`,
    `【注意】${setupWarnings}`,
    "",
    "根據以上資料，說說你現在怎麼看這個市場，以及你的下一步觀察方向。",
  ].join("\n");

  try {
    const resp = await axios.post(`${OLLAMA_URL()}/api/chat`, {
      model:  LLM_MODEL(),
      stream: false,
      think:  false,
      messages: [{ role: "user", content: prompt }],
    }, { timeout: 60000 });
    return String(resp.data?.message?.content || "").trim() || "（市場分析暫無內容）";
  } catch (err) {
    console.warn("[market_observer] LLM trade idea failed:", err.message);
    return `（市場分析生成失敗：${err.code || err.message}）`;
  }
}

function formatVolume(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(v);
}

module.exports = { observe, quickSnapshot, getObservations };
