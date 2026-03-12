"use strict";
// trading_scheduler.js — 晴的自主看盤排程器 + 模擬交易引擎
//
// 規則：
//   1. 看盤時間：週一至週五 08:00–22:00 台灣時間（UTC+8）
//   2. 週末完全停止市場分析（可回顧歷史）
//   3. 初期自由探索看盤頻率（10/15/30/60 分鐘，依命中率加權選擇）
//   4. 累積 30 次觀察後自動優化頻率
//   5. 發現合格 setup（score ≥ 60）→ 自動建立模擬倉位
//   6. 每次看盤同時監控開放中的模擬倉位，觸及 SL/TP 自動平倉
//   7. 每次看盤間隔 > 0 → 不強行重複進場（每資產最多 1 筆開倉）

const path = require("path");
const fs   = require("fs");
const { observe }               = require("./market_observer");
const { logTrade, updateTrade, getOpenSimulatedTrades } = require("./trade_journal");

// ── 常數 ──────────────────────────────────────────────────────────────────────

const ASSETS = ["BTC", "ETH"];

const WINDOW_START = 8;    // 08:00 台灣
const WINDOW_END   = 22;   // 22:00 台灣

const EXPLORE_INTERVALS = [10, 15, 30, 60]; // 分鐘
const DEFAULT_INTERVAL  = 30;
const MIN_OBS_TO_OPTIMIZE = 30;
const SETUP_THRESHOLD   = 60;  // 分數門檻
const MIN_RR            = 1.5; // 最低 R:R 才建倉

const RHYTHM_FILE  = path.join(__dirname, "../../../memory/trades/rhythm.json");
const SETUPS_FILE  = path.join(__dirname, "../../../memory/trades/active_setups.json");

// ── 狀態 ──────────────────────────────────────────────────────────────────────

let _active      = false;
let _timer       = null;
let _mode        = "exploring";
let _intervalMin = DEFAULT_INTERVAL;

const _history      = [];  // 觀察歷史（最多 100）
const _activeSetups = [];  // 合格 setup 快取（最多 10）

// ── 持久化 ────────────────────────────────────────────────────────────────────

function loadRhythm() {
  try {
    if (!fs.existsSync(RHYTHM_FILE)) return;
    const d = JSON.parse(fs.readFileSync(RHYTHM_FILE, "utf8"));
    _mode        = d.mode     || "exploring";
    _intervalMin = d.interval || DEFAULT_INTERVAL;
    if (Array.isArray(d.history)) _history.push(...d.history.slice(-50));
    console.log(`[scheduler] rhythm loaded: mode=${_mode} interval=${_intervalMin}min history=${_history.length}`);
  } catch { /* 從頭開始 */ }
}

function saveRhythm() {
  try {
    fs.mkdirSync(path.dirname(RHYTHM_FILE), { recursive: true });
    fs.writeFileSync(RHYTHM_FILE, JSON.stringify({
      mode: _mode, interval: _intervalMin,
      history: _history.slice(-50), saved_at: Date.now(),
    }, null, 2));
  } catch { /* ignore */ }
}

function loadActiveSetups() {
  try {
    if (fs.existsSync(SETUPS_FILE)) {
      const d = JSON.parse(fs.readFileSync(SETUPS_FILE, "utf8"));
      if (Array.isArray(d)) { _activeSetups.push(...d.slice(-10)); }
    }
  } catch { /* ignore */ }
}

function saveActiveSetups() {
  try {
    fs.mkdirSync(path.dirname(SETUPS_FILE), { recursive: true });
    fs.writeFileSync(SETUPS_FILE, JSON.stringify(_activeSetups.slice(-10), null, 2));
  } catch { /* ignore */ }
}

// ── 台灣時間工具 ───────────────────────────────────────────────────────────────

function getTW() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
}

function isObservationWindow() {
  const tw  = getTW();
  const day = tw.getDay();
  const hr  = tw.getHours();
  if (day === 0 || day === 6) return false;
  return hr >= WINDOW_START && hr < WINDOW_END;
}

function minutesUntilWindow() {
  if (isObservationWindow()) return 0;
  const tw      = getTW();
  const day     = tw.getDay();
  const elapsed = tw.getHours() * 60 + tw.getMinutes();

  if (day >= 1 && day <= 5 && tw.getHours() < WINDOW_START) {
    return WINDOW_START * 60 - elapsed;
  }
  const remainToday   = 24 * 60 - elapsed;
  const toNextMorning = remainToday + WINDOW_START * 60;
  if (day === 5) return toNextMorning + 2 * 24 * 60; // 週五 → 週一
  if (day === 6) return toNextMorning + 1 * 24 * 60; // 週六 → 週一
  return toNextMorning;
}

// ── 頻率探索與優化 ────────────────────────────────────────────────────────────

function pickExploreInterval() {
  if (_history.length < 5) return DEFAULT_INTERVAL;
  const hits = {}; const total = {};
  for (const h of _history) {
    const k = String(h.interval_min);
    total[k] = (total[k] || 0) + 1;
    if (h.score >= SETUP_THRESHOLD) hits[k] = (hits[k] || 0) + 1;
  }
  const weights = EXPLORE_INTERVALS.map(iv => {
    const k = String(iv);
    const n = total[k] || 0;
    const rate = n > 0 ? (hits[k] || 0) / n : 0.5;
    return { iv, weight: 1 + rate * 2 };
  });
  const total_w = weights.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * total_w;
  for (const { iv, weight } of weights) { r -= weight; if (r <= 0) return iv; }
  return EXPLORE_INTERVALS[EXPLORE_INTERVALS.length - 1];
}

function tryOptimizeRhythm() {
  if (_mode === "learned" || _history.length < MIN_OBS_TO_OPTIMIZE) return;
  const recent = _history.slice(-MIN_OBS_TO_OPTIMIZE);
  const hits = {}; const total = {};
  for (const h of recent) {
    const k = String(h.interval_min);
    total[k] = (total[k] || 0) + 1;
    if (h.score >= SETUP_THRESHOLD) hits[k] = (hits[k] || 0) + 1;
  }
  let bestRate = -1; let bestInterval = _intervalMin;
  for (const k of Object.keys(total)) {
    if (total[k] < 3) continue;
    const rate = (hits[k] || 0) / total[k];
    if (rate > bestRate) { bestRate = rate; bestInterval = Number(k); }
  }
  if (bestInterval !== _intervalMin) {
    console.log(`[scheduler] rhythm optimized: ${_intervalMin}min → ${bestInterval}min (hit rate ${(bestRate*100).toFixed(0)}%)`);
    _intervalMin = bestInterval;
    _mode = "learned";
    saveRhythm();
  }
}

// ── 模擬交易引擎 ──────────────────────────────────────────────────────────────

/**
 * 從 DTFX 結構計算模擬倉位的 entry / stop / target
 * - Long：SSL（下方支撐）作 SL，BSL（上方流動性）作 TP
 * - Short：BSL 作 SL，SSL 作 TP
 * - 若無結構水位，用固定 1% SL + 2:1 RR 計算 TP
 */
function calcSimLevels(price, bias, keyLevels) {
  const liq  = keyLevels?.liquidity || {};
  const ssls = (liq.ssl || []).map(l => Number(l.level)).filter(l => l < price).sort((a,b)=>b-a);
  const bsls = (liq.bsl || []).map(l => Number(l.level)).filter(l => l > price).sort((a,b)=>a-b);

  const isLong = bias.includes("long");
  let stop, target;

  if (isLong) {
    stop   = ssls[0] ?? Number((price * 0.99).toFixed(2));
    const riskPts = Math.abs(price - stop);
    target = bsls[0] ?? Number((price + riskPts * 2.0).toFixed(2));
  } else {
    stop   = bsls[0] ?? Number((price * 1.01).toFixed(2));
    const riskPts = Math.abs(stop - price);
    target = ssls[0] ?? Number((price - riskPts * 2.0).toFixed(2));
  }

  stop   = Number(Number(stop).toFixed(2));
  target = Number(Number(target).toFixed(2));
  const risk   = Math.abs(price - stop);
  const reward = Math.abs(target - price);
  const rr     = risk > 0 ? reward / risk : 0;

  return { direction: isLong ? "long" : "short", entry: price, stop, target, rr };
}

/**
 * 判斷模擬倉位是否已觸及 SL 或 TP
 */
function checkSimOutcome(trade, currentPrice) {
  if (trade.direction === "long") {
    if (currentPrice <= trade.stop)  return "loss";
    if (currentPrice >= trade.target) return "win";
  } else {
    if (currentPrice >= trade.stop)  return "loss";
    if (currentPrice <= trade.target) return "win";
  }
  return null; // 尚未觸發
}

/**
 * 監控所有開放模擬倉位，並在觸及 SL/TP 時自動平倉
 * @param {string} asset — "BTC" | "ETH"
 * @param {number} price — 目前市場價格
 */
function monitorSimTrades(asset, price) {
  const pair = `${asset}USDT`;
  const open = getOpenSimulatedTrades().filter(t => t.pair === pair);
  for (const trade of open) {
    const outcome = checkSimOutcome(trade, price);
    if (!outcome) continue;
    const updated = updateTrade(trade.id, {
      status:     "closed",
      sim_status: "auto_closed",
      result:     { outcome, exit_price: price },
    });
    const rr = updated?.result?.rr_achieved ?? "?";
    console.log(`[scheduler] sim trade CLOSED: ${pair} ${trade.direction} → ${outcome} @ ${price} (RR ${rr})`);
  }
}

/**
 * 自動建立模擬倉位（每資產最多 1 筆開倉）
 */
function autoOpenSimTrade(asset, price, bias, keyLevels, structure, score, grade, bestTf, tradeIdea) {
  const pair = `${asset}USDT`;

  // 若已有開放中的模擬倉位 → 不重複建倉
  const alreadyOpen = getOpenSimulatedTrades().some(t => t.pair === pair);
  if (alreadyOpen) {
    console.log(`[scheduler] sim: ${pair} already has open position, skipping.`);
    return null;
  }

  // 方向不明確 → 不建倉
  if (!bias || bias === "neutral") return null;

  const levels = calcSimLevels(price, bias, keyLevels);
  if (levels.rr < MIN_RR) {
    console.log(`[scheduler] sim: ${pair} RR ${levels.rr.toFixed(2)} < ${MIN_RR}, skipping.`);
    return null;
  }

  // 判斷 key_area：優先用 OB，其次 FVG，最後預設結構
  const obs  = keyLevels?.order_blocks || [];
  const fvgs = keyLevels?.fvgs || [];
  let key_area = "structure";
  if (obs.length > 0)  key_area = "OB";
  else if (fvgs.length > 0) key_area = "FVG";

  // 取 h1 結構描述
  const h1 = structure?.["1H"] || {};
  const structDesc = h1.trend ? `${h1.trend} | ${(h1.pattern || []).join("/")}` : "multi-TF confluence";

  const trade = logTrade({
    pair,
    direction:  levels.direction,
    entry:      levels.entry,
    stop:       levels.stop,
    target:     levels.target,
    timeframe:  bestTf || "1H",
    entry_type: "touch_entry",
    key_area,
    structure:  structDesc,
    session:    undefined, // auto-detect by trade_journal
    reason:     `Auto: score=${score} grade=${grade} bias=${bias}. ${tradeIdea ? tradeIdea.slice(0, 120) + "…" : ""}`,
    simulated:  true,
    sim_status: "watching",
  });

  console.log(`[scheduler] sim trade OPENED: ${pair} ${levels.direction} entry=${levels.entry} stop=${levels.stop} target=${levels.target} RR=${levels.rr.toFixed(2)}`);
  return trade;
}

// ── 觀察週期 ──────────────────────────────────────────────────────────────────

async function runObservationCycle() {
  if (!_active) return;

  if (!isObservationWindow()) {
    const waitMin = Math.max(minutesUntilWindow(), 5);
    const tw = getTW();
    const isWeekend = tw.getDay() === 0 || tw.getDay() === 6;
    console.log(`[scheduler] off-hours (TW ${tw.toLocaleTimeString()}, ${isWeekend ? "weekend" : "after hours"}). Next window in ~${waitMin}min.`);
    scheduleNext(waitMin * 60 * 1000);
    return;
  }

  const intervalMin = _mode === "learned" ? _intervalMin : pickExploreInterval();
  _intervalMin = intervalMin;
  const tw = getTW();
  console.log(`[scheduler] observing (TW ${tw.toLocaleTimeString()}, mode=${_mode}, interval=${intervalMin}min)`);

  for (const asset of ASSETS) {
    try {
      // ── Step 1: 快速掃描（noLLM, 取得價格 + 結構）──────────────────────
      const quick = await observe(asset, { noLLM: true });
      const price  = quick.price;
      const score  = quick.confluence?.avg_setup_score || 0;
      const grade  = quick.setup?.grade   || "D";
      const bias   = quick.confluence?.overall_bias || "neutral";
      const bestTf = quick.confluence?.best_entry_tf || null;

      // ── Step 2: 監控開放模擬倉位 ────────────────────────────────────────
      monitorSimTrades(asset, price);

      // ── Step 3: 記錄觀察歷史 ────────────────────────────────────────────
      const entry = { asset, timestamp: Date.now(), score, grade, bias, best_entry_tf: bestTf, interval_min: intervalMin, price };
      _history.push(entry);
      if (_history.length > 100) _history.splice(0, _history.length - 100);

      if (score >= SETUP_THRESHOLD && bias !== "neutral") {
        // ── Step 4a: 有 setup → 生成 LLM 交易想法 ──────────────────────
        console.log(`[scheduler] setup: ${asset} score=${score} grade=${grade} bias=${bias} → generating trade idea...`);
        let tradeIdea = null;
        try {
          const full = await observe(asset, { noLLM: false });
          tradeIdea  = full.trade_idea || null;

          _activeSetups.unshift({
            asset, score, grade, bias, best_entry_tf: bestTf,
            price: full.price, change_pct: full.change_pct,
            structure: full.structure, key_levels: full.key_levels,
            confluence: full.confluence, trade_idea: tradeIdea,
            observed_at: Date.now(),
          });
          if (_activeSetups.length > 10) _activeSetups.splice(10);
          saveActiveSetups();

          // ── Step 4b: 自動建立模擬倉位 ──────────────────────────────────
          autoOpenSimTrade(
            asset, full.price, bias,
            full.key_levels, full.structure,
            score, grade, bestTf, tradeIdea
          );
        } catch (err) {
          console.error(`[scheduler] LLM/sim error for ${asset}:`, err.message);
          // 存 quick 結果，不含 trade idea，仍嘗試建倉
          _activeSetups.unshift({ ...entry, trade_idea: null, observed_at: Date.now() });
          if (_activeSetups.length > 10) _activeSetups.splice(10);
          saveActiveSetups();
          autoOpenSimTrade(asset, price, bias, quick.key_levels, quick.structure, score, grade, bestTf, null);
        }
      } else {
        // ── Step 4c: 無 setup — 靜默觀察 ──────────────────────────────
        console.log(`[scheduler] no setup: ${asset} score=${score} grade=${grade} bias=${bias} — watching.`);
      }
    } catch (err) {
      console.error(`[scheduler] ${asset} error:`, err.message);
    }
  }

  tryOptimizeRhythm();
  saveRhythm();
  scheduleNext(intervalMin * 60 * 1000);
}

function scheduleNext(ms) {
  if (!_active) return;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(runObservationCycle, ms);
}

// ── Public API ────────────────────────────────────────────────────────────────

function startScheduler() {
  if (_active) return;
  _active = true;
  loadRhythm();
  loadActiveSetups();
  console.log(`[scheduler] 晴 trading scheduler started (mode=${_mode}, interval=${_intervalMin}min)`);
  _timer = setTimeout(runObservationCycle, 10 * 1000);
}

function stopScheduler() {
  _active = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  console.log("[scheduler] 晴 trading scheduler stopped.");
}

function getSchedulerStatus() {
  const tw = getTW();
  const isWeekend = tw.getDay() === 0 || tw.getDay() === 6;
  const hitCount  = _history.filter(h => h.score >= SETUP_THRESHOLD).length;
  const openSims  = getOpenSimulatedTrades().length;
  return {
    active:               _active,
    in_window:            isObservationWindow(),
    is_weekend:           isWeekend,
    mode:                 _mode,
    current_interval_min: _intervalMin,
    observations_total:   _history.length,
    setup_hits:           hitCount,
    setup_hit_rate:       _history.length > 0 ? Number((hitCount / _history.length).toFixed(3)) : 0,
    active_setups:        _activeSetups.length,
    open_sim_trades:      openSims,
    taiwan_time:          tw.toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
    next_window_min:      minutesUntilWindow(),
    recent_obs:           _history.slice(-5).reverse(),
  };
}

function getActiveSetups() { return _activeSetups; }

module.exports = { startScheduler, stopScheduler, getSchedulerStatus, getActiveSetups };
