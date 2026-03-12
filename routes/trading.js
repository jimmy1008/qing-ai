"use strict";
// routes/trading.js — DTFX Trading Behavior API
//
// POST /api/trading/log           — 記錄新交易計畫
// PATCH /api/trading/log/:id      — 更新交易結果
// GET  /api/trading/journal       — 最近 N 筆交易
// GET  /api/trading/stats         — 統計數據
// POST /api/trading/reflect/:id   — 生成單筆交易反思
// GET  /api/trading/review        — 最近 N 筆的週期性回顧
// GET  /api/trading/hypothesis    — 策略優化假設
// POST /api/trading/analyze       — 分析入場 setup（入場前評估）

const express = require("express");
const { DTFX_CORE, validateSetup } = require("../ai/modules/trading/dtfx_core");
const {
  logTrade, updateTrade, getRecentTrades, getTrade, getClosedTrades, getStats,
} = require("../ai/modules/trading/trade_journal");
const {
  reflectOnTrade, periodicReview, generateHypothesis, analyzeSetup,
} = require("../ai/modules/trading/trade_reflector");

const router = express.Router();

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
router.get("/api/trading/journal", (req, res) => {
  const n = Math.min(Number(req.query.n) || 50, 200);
  res.json({ trades: getRecentTrades(n) });
});

// ── Get trade by id ───────────────────────────────────────────────────────────
router.get("/api/trading/log/:id", (req, res) => {
  const trade = getTrade(req.params.id);
  if (!trade) return res.status(404).json({ error: "Not found" });
  res.json(trade);
});

// ── Stats ─────────────────────────────────────────────────────────────────────
router.get("/api/trading/stats", (_req, res) => {
  res.json(getStats());
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
