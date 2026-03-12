"use strict";
// routes/trading.js — DTFX Trading Behavior API
//
// ── Market Observation (TradingView) ──
// GET  /api/trading/observe/:asset       — full observe + LLM trade idea (BTC or ETH)
// GET  /api/trading/observe/:asset/quick — price snapshot only (fast)
// GET  /api/trading/observe/:asset/history — recent observations cache
//
// ── 晴 Scheduler ──
// GET  /api/trading/scheduler    — 排程器狀態（看盤時間、模式、命中率）
// GET  /api/trading/setups       — 近期合格 setup 列表
//
// ── Trade Journal ──
// POST /api/trading/log              — 記錄新交易計畫
// PATCH /api/trading/log/:id         — 更新交易結果
// GET  /api/trading/journal          — 最近 N 筆交易（?simulated=1 只看模擬）
// GET  /api/trading/stats            — 真實交易統計數據
// GET  /api/trading/stats/simulated  — 模擬交易統計數據
// GET  /api/trading/simulated        — 目前開放中的模擬倉位
// POST /api/trading/reflect/:id      — 生成單筆交易反思
// GET  /api/trading/review           — 最近 N 筆的週期性回顧
// GET  /api/trading/hypothesis       — 策略優化假設
// POST /api/trading/analyze          — 分析入場 setup（入場前評估）
// GET  /api/trading/core             — DTFX Core reference

const express = require("express");
const { DTFX_CORE, validateSetup } = require("../ai/modules/trading/dtfx_core");
const {
  logTrade, updateTrade, getRecentTrades, getTrade, getClosedTrades, getStats,
  getOpenSimulatedTrades, getSimulatedStats,
} = require("../ai/modules/trading/trade_journal");
const {
  reflectOnTrade, periodicReview, generateHypothesis, analyzeSetup,
} = require("../ai/modules/trading/trade_reflector");
const {
  observe, quickSnapshot, getObservations,
} = require("../ai/modules/trading/market_observer");
const {
  getSchedulerStatus, getActiveSetups,
} = require("../ai/modules/trading/trading_scheduler");

const router = express.Router();

// ── Market Observation ────────────────────────────────────────────────────────

// Full observation: fetch TradingView data → DTFX analysis → LLM trade idea
// ?no_llm=1 to skip LLM (faster, returns raw analysis only)
router.get("/api/trading/observe/:asset", async (req, res) => {
  const asset = req.params.asset.toUpperCase();
  if (asset !== "BTC" && asset !== "ETH") {
    return res.status(400).json({ error: "Only BTC and ETH are supported." });
  }
  try {
    const result = await observe(asset, { noLLM: req.query.no_llm === "1" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Quick snapshot: current price + indicators only (no candle analysis)
router.get("/api/trading/observe/:asset/quick", async (req, res) => {
  const asset = req.params.asset.toUpperCase();
  try {
    const snap = await quickSnapshot(asset);
    res.json(snap);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recent observation history (cached in memory)
router.get("/api/trading/observe/:asset/history", (req, res) => {
  const asset = req.params.asset.toUpperCase();
  const n = Math.min(Number(req.query.n) || 10, 20);
  res.json({ observations: getObservations(asset, n) });
});

// ── Scheduler status & active setups ─────────────────────────────────────────

// 晴排程器狀態：看盤時間、模式（探索/已優化）、命中率、近期觀察
router.get("/api/trading/scheduler", (_req, res) => {
  res.json(getSchedulerStatus());
});

// 近期發現的合格 setup（score >= 60）
router.get("/api/trading/setups", (_req, res) => {
  res.json({ setups: getActiveSetups() });
});

// ── Log a new trade plan ──────────────────────────────────────────────────────
// Body: { pair, direction, entry, stop, target, entry_type, key_area, structure,
//         reason, session, timeframe, auxiliary }
router.post("/api/trading/log", (req, res) => {
  const data = req.body;
  if (!data.pair || !data.entry || !data.stop || !data.target) {
    return res.status(400).json({ error: "必填：pair, entry, stop, target" });
  }
  const validation = validateSetup(data);
  const trade = logTrade(data);
  res.json({ ok: true, trade, validation });
});

// ── Update trade result ───────────────────────────────────────────────────────
// Body: { status, result: { outcome, exit_price }, reflection }
router.patch("/api/trading/log/:id", (req, res) => {
  const trade = updateTrade(req.params.id, req.body);
  if (!trade) return res.status(404).json({ error: "Trade not found" });
  res.json({ ok: true, trade });
});

// ── Get recent journal ────────────────────────────────────────────────────────
// ?simulated=1 → 只回傳模擬交易；?simulated=0 → 只回傳真實交易
router.get("/api/trading/journal", (req, res) => {
  const n    = Math.min(Number(req.query.n) || 50, 200);
  let trades = getRecentTrades(n);
  if (req.query.simulated === "1") trades = trades.filter(t => t.simulated === true);
  if (req.query.simulated === "0") trades = trades.filter(t => !t.simulated);
  res.json({ trades });
});

// ── Get trade by id ───────────────────────────────────────────────────────────
router.get("/api/trading/log/:id", (req, res) => {
  const trade = getTrade(req.params.id);
  if (!trade) return res.status(404).json({ error: "Not found" });
  res.json(trade);
});

// ── Stats ─────────────────────────────────────────────────────────────────────
// 真實交易統計（排除模擬倉位）
router.get("/api/trading/stats", (_req, res) => {
  res.json(getStats());
});

// 模擬交易統計
router.get("/api/trading/stats/simulated", (_req, res) => {
  res.json(getSimulatedStats());
});

// 目前開放中的模擬倉位
router.get("/api/trading/simulated", (_req, res) => {
  res.json({ simulated: getOpenSimulatedTrades() });
});

// ── DTFX Core reference ───────────────────────────────────────────────────────
router.get("/api/trading/core", (_req, res) => {
  res.json(DTFX_CORE);
});

// ── Reflect on single trade (LLM) ─────────────────────────────────────────────
router.post("/api/trading/reflect/:id", async (req, res) => {
  const trade = getTrade(req.params.id);
  if (!trade) return res.status(404).json({ error: "Trade not found" });
  if (trade.status === "open") return res.status(400).json({ error: "交易尚未結束" });

  try {
    const reflection = await reflectOnTrade(trade);
    // Persist reflection back to journal
    const updated = updateTrade(trade.id, { reflection });
    res.json({ ok: true, reflection, trade: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Periodic review of last N closed trades (LLM) ────────────────────────────
router.get("/api/trading/review", async (req, res) => {
  const n = Math.min(Number(req.query.n) || 20, 50);
  const closed = getClosedTrades().slice(-n);
  if (closed.length === 0) return res.json({ review: "還沒有已完成的交易可以回顧。" });

  try {
    const review = await periodicReview(closed);
    res.json({ ok: true, review, trades_reviewed: closed.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Strategy optimization hypothesis (LLM) ───────────────────────────────────
router.get("/api/trading/hypothesis", async (_req, res) => {
  const stats  = getStats();
  const closed = getClosedTrades();
  if (closed.length < 5) return res.json({ hypothesis: "還需要更多交易資料（至少 5 筆完結）才能提出假設。" });

  try {
    const hypothesis = await generateHypothesis(stats, closed);
    res.json({ ok: true, hypothesis, based_on: closed.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pre-trade setup analysis (LLM) ───────────────────────────────────────────
// Body: { pair, direction, entry, stop, target, entry_type, key_area, structure, session }
router.post("/api/trading/analyze", async (req, res) => {
  const setup = req.body;
  if (!setup.pair || !setup.direction) {
    return res.status(400).json({ error: "必填：pair, direction" });
  }
  const validation = validateSetup(setup);

  try {
    const analysis  = await analyzeSetup(setup);
    res.json({ ok: true, analysis, validation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
