"use strict";
// trade_journal.js
// Per-session JSONL trade log for 晴's trading activity.
// Stored at: memory/trades/journal.jsonl
//
// Trade schema:
// {
//   id:           string (uuid),
//   created_at:   number (epoch ms),
//   updated_at:   number,
//   pair:         string,              // e.g. "BTCUSDT"
//   direction:    "long"|"short",
//   session:      "asia"|"london"|"new_york"|"unknown",
//   timeframe:    string,              // e.g. "1H", "4H"
//   entry:        number,
//   stop:         number,
//   target:       number,
//   rr_planned:   number,              // planned R:R
//   entry_type:   string,              // touch/confirmation/structure_confirmation
//   key_area:     string,              // OB/FVG/SSL/BSL/EQ
//   structure:    string,              // BOS/CHoCH/trend description
//   reason:       string,              // free text — why this setup
//   auxiliary:    object,             // { funding_rate, volume, oi, notes }
//   status:       "open"|"closed"|"invalidated",
//   result: {
//     outcome:    "win"|"loss"|"breakeven"|null,
//     exit_price: number|null,
//     rr_achieved:number|null,
//     pnl_pct:    number|null,
//   },
//   reflection:   string|null,         // 晴的反思文字
// }

const fs   = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const TRADES_DIR  = path.join(__dirname, "../../../memory/trades");
const JOURNAL_PATH = path.join(TRADES_DIR, "journal.jsonl");

function ensureDir() {
  fs.mkdirSync(TRADES_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(JOURNAL_PATH)) return [];
  try {
    return fs.readFileSync(JOURNAL_PATH, "utf-8")
      .split("\n").filter(Boolean)
      .map(l => JSON.parse(l))
      .filter(Boolean);
  } catch { return []; }
}

function saveAll(trades) {
  ensureDir();
  fs.writeFileSync(JOURNAL_PATH, trades.map(t => JSON.stringify(t)).join("\n") + "\n", "utf-8");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Log a new planned trade.
 * Returns the saved trade object with generated id.
 */
function logTrade(data) {
  const trades = loadAll();
  const now = Date.now();

  const trade = {
    id:          randomUUID(),
    created_at:  now,
    updated_at:  now,
    pair:        String(data.pair || "").toUpperCase(),
    direction:   data.direction === "short" ? "short" : "long",
    session:     data.session || detectSession(),
    timeframe:   data.timeframe || "1H",
    entry:       Number(data.entry) || 0,
    stop:        Number(data.stop)  || 0,
    target:      Number(data.target) || 0,
    rr_planned:  computeRR(data),
    entry_type:  data.entry_type || "confirmation_entry",
    key_area:    data.key_area   || "",
    structure:   data.structure  || "",
    reason:      data.reason     || "",
    auxiliary:   data.auxiliary  || {},
    simulated:   data.simulated === true,   // 模擬倉位標記
    sim_status:  data.simulated === true ? (data.sim_status || "watching") : undefined,
    status:      "open",
    result: {
      outcome:     null,
      exit_price:  null,
      rr_achieved: null,
      pnl_pct:     null,
    },
    reflection: null,
  };

  trades.push(trade);
  saveAll(trades);
  return trade;
}

/**
 * Update a trade's result (close or invalidate).
 */
function updateTrade(id, patch) {
  const trades = loadAll();
  const idx = trades.findIndex(t => t.id === id);
  if (idx === -1) return null;

  const trade = trades[idx];
  if (patch.result)     Object.assign(trade.result, patch.result);
  if (patch.status)     trade.status = patch.status;
  if (patch.reflection) trade.reflection = patch.reflection;
  if (patch.sim_status) trade.sim_status = patch.sim_status;
  trade.updated_at = Date.now();

  // Auto-compute rr_achieved
  if (trade.result.exit_price != null && trade.entry && trade.stop) {
    const risk = Math.abs(trade.entry - trade.stop);
    const reward = trade.direction === "long"
      ? trade.result.exit_price - trade.entry
      : trade.entry - trade.result.exit_price;
    trade.result.rr_achieved = risk > 0 ? Number((reward / risk).toFixed(2)) : null;
    trade.result.pnl_pct = risk > 0 ? Number(((reward / trade.entry) * 100).toFixed(3)) : null;
  }

  trades[idx] = trade;
  saveAll(trades);
  return trade;
}

/**
 * Get recent N trades (default: 20).
 */
function getRecentTrades(n = 20) {
  return loadAll().slice(-n).reverse();
}

/**
 * Get a single trade by id.
 */
function getTrade(id) {
  return loadAll().find(t => t.id === id) || null;
}

/**
 * Get all closed trades.
 */
function getClosedTrades() {
  return loadAll().filter(t => t.status === "closed");
}

/**
 * Compute statistics over all closed REAL trades (excluding simulated).
 */
function getStats() {
  const closed = getClosedTrades().filter(t => !t.simulated);
  if (closed.length === 0) return { total: 0, wins: 0, losses: 0, breakeven: 0, winRate: 0, avgRR: 0, byPair: {}, bySession: {}, byEntryType: {} };

  const wins      = closed.filter(t => t.result.outcome === "win").length;
  const losses    = closed.filter(t => t.result.outcome === "loss").length;
  const breakeven = closed.filter(t => t.result.outcome === "breakeven").length;
  const rrValues  = closed.map(t => t.result.rr_achieved).filter(r => r != null);
  const avgRR     = rrValues.length ? Number((rrValues.reduce((a,b) => a+b, 0) / rrValues.length).toFixed(2)) : 0;

  const byPair    = groupBy(closed, "pair",       t => outcomeStats(closed.filter(x => x.pair === t.pair)));
  const bySession = groupBy(closed, "session",    t => outcomeStats(closed.filter(x => x.session === t.session)));
  const byEntryType = groupBy(closed, "entry_type", t => outcomeStats(closed.filter(x => x.entry_type === t.entry_type)));

  return {
    total:     closed.length,
    wins, losses, breakeven,
    winRate:   Number(((wins / closed.length) * 100).toFixed(1)),
    avgRR,
    byPair, bySession, byEntryType,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeRR(data) {
  const entry  = Number(data.entry)  || 0;
  const stop   = Number(data.stop)   || 0;
  const target = Number(data.target) || 0;
  if (!entry || !stop || !target) return 0;
  const risk   = Math.abs(entry - stop);
  const reward = data.direction === "short" ? entry - target : target - entry;
  return risk > 0 ? Number((reward / risk).toFixed(2)) : 0;
}

function detectSession() {
  // Market session hours in UTC:
  //   Asia:     00:00–09:00
  //   London:   07:00–16:00
  //   New York: 13:00–22:00
  // Overlaps are named explicitly for better strategy attribution.
  const hour = new Date().getUTCHours();
  const inAsia   = hour >= 0  && hour < 9;
  const inLondon = hour >= 7  && hour < 16;
  const inNY     = hour >= 13 && hour < 22;

  if (inLondon && inNY) return "london_ny";     // 13:00–16:00 UTC — highest volatility
  if (inAsia && inLondon) return "asia_london"; // 07:00–09:00 UTC — London open
  if (inNY)     return "new_york";
  if (inLondon) return "london";
  if (inAsia)   return "asia";
  return "off_hours";
}

function outcomeStats(trades) {
  const total  = trades.length;
  const wins   = trades.filter(t => t.result.outcome === "win").length;
  const rrVals = trades.map(t => t.result.rr_achieved).filter(r => r != null);
  const avgRR  = rrVals.length ? Number((rrVals.reduce((a,b) => a+b,0) / rrVals.length).toFixed(2)) : 0;
  return { total, wins, winRate: total ? Number(((wins/total)*100).toFixed(1)) : 0, avgRR };
}

function groupBy(arr, key, statsFn) {
  const groups = {};
  for (const item of arr) {
    const k = item[key] || "unknown";
    if (!groups[k]) groups[k] = statsFn(item);
  }
  return groups;
}

/**
 * Get all open simulated trades (simulated: true && status: "open").
 */
function getOpenSimulatedTrades() {
  return loadAll().filter(t => t.simulated === true && t.status === "open");
}

/**
 * Get stats for simulated trades only (closed).
 */
function getSimulatedStats() {
  const closed = getClosedTrades().filter(t => t.simulated === true);
  if (closed.length === 0) return { total: 0, wins: 0, losses: 0, breakeven: 0, winRate: 0, avgRR: 0 };
  const wins      = closed.filter(t => t.result.outcome === "win").length;
  const losses    = closed.filter(t => t.result.outcome === "loss").length;
  const breakeven = closed.filter(t => t.result.outcome === "breakeven").length;
  const rrVals    = closed.map(t => t.result.rr_achieved).filter(r => r != null);
  const avgRR     = rrVals.length ? Number((rrVals.reduce((a,b)=>a+b,0)/rrVals.length).toFixed(2)) : 0;
  return { total: closed.length, wins, losses, breakeven, winRate: Number(((wins/closed.length)*100).toFixed(1)), avgRR };
}

module.exports = {
  logTrade, updateTrade, getRecentTrades, getTrade, getClosedTrades, getStats,
  getOpenSimulatedTrades, getSimulatedStats,
};
