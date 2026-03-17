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
const { observe }                                                        = require("./market_observer");
const { logTrade, updateTrade, getOpenSimulatedTrades, getClosedTrades,
        getSimulatedStats, getStats, getRecentTrades }                   = require("./trade_journal");
const { periodicReview, generateHypothesis, generateObservationInsight } = require("./trade_reflector");
const { isNearHighImpactNews }                                           = require("./news_calendar");

// ── 常數 ──────────────────────────────────────────────────────────────────────

const ASSETS = ["BTC", "ETH"];

// 加密貨幣 24/7 全天候 — 無時間窗口限制
const WINDOW_START = 0;    // 00:00
const WINDOW_END   = 24;   // 24:00 (全天)

const EXPLORE_INTERVALS   = [5, 10, 15, 30]; // 分鐘（最短 5 分鐘）
const DEFAULT_INTERVAL    = 10;
const MIN_OBS_TO_OPTIMIZE = 20; // 20 次觀察後即可優化頻率
const SETUP_THRESHOLD     = 60;   // 標準開倉：score ≥ 60
const HIGH_RR_THRESHOLD   = 2.5;  // 備用開倉：RR ≥ 2.5 時可放寬分數要求
const HIGH_RR_MIN_SCORE   = 45;   // 備用開倉的最低分數下限（防止垃圾 setup 被 RR 救活）
const MIN_RR              = 1.5;  // 最低 R:R 才建倉
const MAX_POSITIONS       = 2;    // 最多同時持有倉位（含所有幣種）
const SIM_ACCOUNT_SIZE    = 10000; // 模擬帳戶規模（USD）
const MAX_RISK_PCT        = 0.01;  // 每筆最大風險 1%
const NEWS_WINDOW_MIN     = 30;   // 重大消息前後 30 分鐘不建倉
const DAILY_MIN_TRADES    = 1;    // Weekday floor: at least 1 new trade per TW day

// ── 評級輔助 ──────────────────────────────────────────────────────────────────
// observer 未回傳 grade 時的保底計算；顯示標籤統一由此輸出
const GRADE_THRESHOLDS = [
  { min: 80, grade: "A",  label: "A 級 ✦ 強勢信號" },
  { min: 65, grade: "B",  label: "B 級 ✧ 合格信號" },
  { min: 50, grade: "C",  label: "C 級 △ 偏弱信號" },
  { min:  0, grade: "D",  label: "D 級 ✕ 不合格"   },
];

function computeGrade(score) {
  for (const { min, grade } of GRADE_THRESHOLDS) {
    if (score >= min) return grade;
  }
  return "D";
}

function gradeLabel(grade) {
  return GRADE_THRESHOLDS.find(g => g.grade === grade)?.label || `${grade} 級`;
}

const RHYTHM_FILE      = path.join(__dirname, "../../../memory/trades/rhythm.json");
const SETUPS_FILE      = path.join(__dirname, "../../../memory/trades/active_setups.json");
const REVIEWS_FILE     = path.join(__dirname, "../../../memory/trades/reviews.jsonl");
const STATS_FILE       = path.join(__dirname, "../../../memory/trades/stats.json");
const HYPOTHESES_FILE  = path.join(__dirname, "../../../memory/trades/hypotheses.jsonl");
const WEEKLY_LOG_FILE  = path.join(__dirname, "../../../memory/trades/weekly_obs_log.jsonl");
const VIEWS_FILE       = path.join(__dirname, "../../../memory/trades/sim_views.jsonl");
const OBS_INSIGHT_FILE = path.join(__dirname, "../../../memory/trades/obs_insights.jsonl");

// ── 狀態 ──────────────────────────────────────────────────────────────────────

let _active      = false;
let _timer       = null;
let _mode        = "exploring";
let _intervalMin = DEFAULT_INTERVAL;

// 反思觸發計數（每 5 筆平倉觸發一次 periodicReview）
let _closedSinceLastReview = 0;
// 連續虧損 / 連續獲利計數（動態風控 + 情緒狀態）
let _consecutiveLosses = 0;
let _consecutiveWins   = 0;
// 首次啟動時間（學習進度計算）
let _startedAt = null;
// 當前學習疑問（規則生成，每 30 次觀察更新一次）
let _currentCuriosity = null;
// 即將到來的高影響事件提示（每次觀察週期更新，注入到對話情緒背景）
let _anticipationHint = null;
// 觀察計數器（持久化）
let _totalObservations = 0;  // 累計總觀察次數（不重置）
let _weeklyObs         = 0;  // 本週觀察次數（每週一 00:00 台灣時間重置）
let _weekStart         = null; // 本週開始的 ISO 字串（例："2026-03-09"）

const _history      = [];  // 觀察歷史（最多 500）
const _activeSetups = [];  // 合格 setup 快取（最多 10）

// ── 持久化 ────────────────────────────────────────────────────────────────────

function loadRhythm() {
  try {
    if (!fs.existsSync(RHYTHM_FILE)) return;
    const d = JSON.parse(fs.readFileSync(RHYTHM_FILE, "utf8"));
    _mode                  = d.mode     || "exploring";
    _intervalMin           = d.interval || DEFAULT_INTERVAL;
    _closedSinceLastReview = Number(d.closed_since_review) || 0;
    _consecutiveLosses     = Number(d.consecutive_losses)  || 0;
    _consecutiveWins       = Number(d.consecutive_wins)    || 0;
    _startedAt             = d.started_at  || null;
    _currentCuriosity      = d.curiosity   || null;
    _totalObservations     = Number(d.total_observations) || 0;
    _weeklyObs             = Number(d.weekly_obs)         || 0;
    _weekStart             = d.week_start  || null;
    if (Array.isArray(d.history)) _history.push(...d.history.slice(-100));
    console.log(`[scheduler] rhythm loaded: mode=${_mode} interval=${_intervalMin}min history=${_history.length} consecutive_losses=${_consecutiveLosses}`);
  } catch { /* 從頭開始 */ }
}

function saveRhythm() {
  try {
    fs.mkdirSync(path.dirname(RHYTHM_FILE), { recursive: true });
    fs.writeFileSync(RHYTHM_FILE, JSON.stringify({
      mode: _mode, interval: _intervalMin,
      closed_since_review: _closedSinceLastReview,
      consecutive_losses:  _consecutiveLosses,
      consecutive_wins:    _consecutiveWins,
      started_at:          _startedAt,
      curiosity:           _currentCuriosity,
      total_observations:  _totalObservations,
      weekly_obs:          _weeklyObs,
      week_start:          _weekStart,
      history: _history.slice(-100), saved_at: Date.now(),
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

function getTWDateKey(ms = Date.now()) {
  const d = new Date(new Date(ms).toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  return d.toISOString().slice(0, 10);
}

function isWeekdayTW(ms = Date.now()) {
  const d = new Date(new Date(ms).toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

function getTodayTradeCountTW() {
  const todayKey = getTWDateKey(Date.now());
  const recent = getRecentTrades(500);
  return recent.filter((t) => t && t.created_at && getTWDateKey(t.created_at) === todayKey).length;
}

function isObservationWindow() {
  // 加密貨幣 24/7，全週無限制
  return true;
}

function minutesUntilWindow() {
  return 0; // 24/7 — 永遠在觀察窗口內
}

// 取得台灣時間本週一 00:00 的日期字串（YYYY-MM-DD）
function getCurrentWeekStart() {
  const tw = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const day = tw.getDay(); // 0=Sun, 1=Mon...
  const diff = (day === 0 ? -6 : 1 - day); // 往回到週一
  tw.setDate(tw.getDate() + diff);
  return tw.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// 每週一 00:00 台灣時間重置本週觀察計數，並記錄到 weekly_obs_log.jsonl
function checkWeeklyReset() {
  try {
    const currentWeek = getCurrentWeekStart();
    if (_weekStart === currentWeek) return; // 同一週，不重置

    if (_weekStart !== null && _weeklyObs > 0) {
      // 記錄上週的統計
      const hitCount = _history.filter(h => h.score >= SETUP_THRESHOLD).length;
      const hitRate  = _weeklyObs > 0 ? Number((hitCount / Math.min(_weeklyObs, _history.length)).toFixed(3)) : 0;
      const simStats = getSimulatedStats();
      const entry = {
        week_start:      _weekStart,
        week_end:        currentWeek,
        observations:    _weeklyObs,
        setup_hits:      hitCount,
        setup_hit_rate:  hitRate,
        sim_total:       simStats.total,
        sim_win_rate:    simStats.winRate,
        sim_avg_rr:      simStats.avgRR,
        logged_at:       new Date().toISOString(),
      };
      fs.mkdirSync(path.dirname(WEEKLY_LOG_FILE), { recursive: true });
      fs.appendFileSync(WEEKLY_LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
      console.log(`[scheduler] weekly reset: week=${_weekStart} obs=${_weeklyObs} setup_hits=${hitCount} → logged`);
    }

    _weekStart = currentWeek;
    _weeklyObs = 0;
    saveRhythm();
  } catch { /* non-blocking */ }
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
 * 優先使用 high/low（K 棒內觸及）而非只用收盤價，避免目標價在 K 棒內被穿越後未觸發
 * @param {object} trade
 * @param {number} close  — 當前收盤/最後價
 * @param {number} [high] — 當根 K 棒最高
 * @param {number} [low]  — 當根 K 棒最低
 */
function checkSimOutcome(trade, close, high, low) {
  const hi = high ?? close;
  const lo = low  ?? close;
  if (trade.direction === "long") {
    if (lo  <= trade.stop)   return "loss"; // K 棒最低觸及止損
    if (hi  >= trade.target) return "win";  // K 棒最高觸及目標
  } else {
    if (hi  >= trade.stop)   return "loss"; // K 棒最高觸及止損
    if (lo  <= trade.target) return "win";  // K 棒最低觸及目標
  }
  return null; // 尚未觸發
}

/**
 * 監控所有開放模擬倉位，並在觸及 SL/TP 時自動平倉
 * @param {string} asset   — "BTC" | "ETH"
 * @param {number} price   — 最新收盤價
 * @param {number} [high]  — 當根 K 棒最高（可選）
 * @param {number} [low]   — 當根 K 棒最低（可選）
 * @returns {number} count of trades closed in this call
 */
function monitorSimTrades(asset, price, high, low) {
  const pair = `${asset}USDT`;
  const open = getOpenSimulatedTrades().filter(t => t.pair === pair);
  let closedCount = 0;
  for (const trade of open) {
    const outcome = checkSimOutcome(trade, price, high, low);
    if (!outcome) continue;
    const now = Date.now();
    const updated = updateTrade(trade.id, {
      status:      "closed",
      sim_status:  "auto_closed",
      closed_at:   now,
      exit_reason: outcome === "win" ? "tp_hit" : "sl_hit",
      result:      { outcome, exit_price: price },
    });
    const rr = updated?.result?.rr_achieved ?? "?";
    console.log(`[scheduler] sim trade CLOSED: ${pair} ${trade.direction} → ${outcome} @ ${price} (RR ${rr})`);
    closedCount++;
    // 動態風控：追蹤連續虧損 / 連續獲利
    if (outcome === "win") {
      _consecutiveLosses = 0;
      _consecutiveWins++;
    } else if (outcome === "loss") {
      _consecutiveLosses++;
      _consecutiveWins = 0;
      if (_consecutiveLosses >= 2) {
        console.log(`[scheduler] risk reduced: ${_consecutiveLosses} consecutive losses → effective risk halved`);
      }
      if (_consecutiveLosses >= 4) {
        console.log(`[scheduler] trading paused: ${_consecutiveLosses} consecutive losses — will skip next open signal`);
      }
    }
  }
  return closedCount;
}

/**
 * 自動建立模擬倉位
 * 風控：每資產 1 筆、全局最多 MAX_POSITIONS、RR ≥ MIN_RR、1% 最大風險
 * 新聞：重大消息前後 NEWS_WINDOW_MIN 分鐘內不建倉
 */
async function autoOpenSimTrade(asset, price, bias, keyLevels, structure, score, grade, bestTf, tradeIdea, opts = {}) {
  const pair = `${asset}USDT`;
  const forceDaily = opts && opts.forceDaily === true;

  // 每資產最多 1 筆開倉
  const openSims = getOpenSimulatedTrades();
  if (!forceDaily && openSims.some(t => t.pair === pair)) {
    console.log(`[scheduler] sim: ${pair} already has open position, skipping.`);
    return null;
  }

  // 全局最多 MAX_POSITIONS 筆
  if (!forceDaily && openSims.length >= MAX_POSITIONS) {
    console.log(`[scheduler] sim: max positions (${MAX_POSITIONS}) reached, skipping ${pair}.`);
    return null;
  }

  // 方向不明確 → 不建倉
  if (!bias || bias === "neutral") return null;

  // 動態風控：連續虧損 ≥ 4 → 暫停建倉
  if (!forceDaily && _consecutiveLosses >= 4) {
    console.log(`[scheduler] sim: trading paused (${_consecutiveLosses} consecutive losses), skipping ${pair}.`);
    return null;
  }

  // 重大消息前後不建倉
  try {
    const { near, events } = await isNearHighImpactNews(NEWS_WINDOW_MIN);
    if (!forceDaily && near) {
      const titles = events.map(e => e.title).join(", ");
      console.log(`[scheduler] sim: near high-impact news (${titles}), skipping ${pair}.`);
      return null;
    }
  } catch { /* 行事曆抓取失敗不阻止建倉 */ }

  const levels = calcSimLevels(price, bias, keyLevels);
  const minRR = forceDaily ? 0 : MIN_RR;
  if (levels.rr < minRR) {
    console.log(`[scheduler] sim: ${pair} RR ${levels.rr.toFixed(2)} < ${minRR}, skipping.`);
    return null;
  }

  // 動態風控：連續虧損 ≥ 2 → 風險減半
  const effectiveRiskPct = _consecutiveLosses >= 2 ? MAX_RISK_PCT * 0.5 : MAX_RISK_PCT;
  const maxRiskUSD  = SIM_ACCOUNT_SIZE * effectiveRiskPct;
  const riskPerUnit = Math.abs(levels.entry - levels.stop);
  const positionSizeUSD = riskPerUnit > 0 ? maxRiskUSD / (riskPerUnit / levels.entry) : maxRiskUSD;

  // 判斷 key_area：優先用 OB，其次 FVG，最後預設結構
  const obs  = keyLevels?.order_blocks || [];
  const fvgs = keyLevels?.fvgs || [];
  let key_area = "structure";
  if (obs.length > 0)       key_area = "OB";
  else if (fvgs.length > 0) key_area = "FVG";

  // 取 h1 結構描述
  const h1 = structure?.["1H"] || {};
  const structDesc = h1.trend ? `${h1.trend} | ${(h1.pattern || []).join("/")}` : "multi-TF confluence";

  const effectiveGrade = grade || computeGrade(score);
  const gradeLabelStr  = gradeLabel(effectiveGrade);
  const openMode       = forceDaily ? "AutoDaily" : (score >= SETUP_THRESHOLD ? "AutoScore" : "AutoHighRR");
  const tradeReason    = [
    `【${gradeLabelStr}】`,
    `${openMode} | score=${score} | RR=${levels.rr.toFixed(2)} | bias=${bias}`,
    tradeIdea ? tradeIdea.slice(0, 120) : "",
  ].filter(Boolean).join(" — ");

  const trade = logTrade({
    pair,
    direction:   levels.direction,
    entry:       levels.entry,
    stop:        levels.stop,
    target:      levels.target,
    timeframe:   bestTf || "1H",
    entry_type:  "touch_entry",
    key_area,
    structure:   structDesc,
    session:     undefined, // auto-detect by trade_journal
    entry_score: score,
    grade:       effectiveGrade,
    reason:      tradeReason,
    auxiliary: {
      sim_account_size:  SIM_ACCOUNT_SIZE,
      position_size_usd: Number(positionSizeUSD.toFixed(2)),
      risk_usd:          Number(maxRiskUSD.toFixed(2)),
      risk_pct:          (effectiveRiskPct * 100).toFixed(1) + "%",
      consecutive_losses: _consecutiveLosses,
    },
    simulated:  true,
    sim_status: "watching",
  });

  console.log(`[scheduler] sim trade OPENED [${gradeLabelStr}]: ${pair} ${levels.direction} entry=${levels.entry} stop=${levels.stop} target=${levels.target} RR=${levels.rr.toFixed(2)} score=${score} size=$${positionSizeUSD.toFixed(0)}`);
  return trade;
}

async function ensureWeekdayDailyMinimumTrade(bestCandidate) {
  if (!isWeekdayTW()) return null;
  if (getTodayTradeCountTW() >= DAILY_MIN_TRADES) return null;
  if (!bestCandidate || !bestCandidate.bias || bestCandidate.bias === "neutral") {
    console.log("[scheduler] daily minimum: no valid candidate to force today.");
    return null;
  }

  const opened = await autoOpenSimTrade(
    bestCandidate.asset,
    bestCandidate.price,
    bestCandidate.bias,
    bestCandidate.keyLevels,
    bestCandidate.structure,
    bestCandidate.score,
    bestCandidate.grade,
    bestCandidate.bestTf,
    null,
    { forceDaily: true }
  );

  if (opened) {
    console.log(`[scheduler] daily minimum satisfied: forced 1 trade for ${getTWDateKey()}.`);
  }
  return opened;
}

// ── 模擬看法記錄（不開倉，只記觀點）────────────────────────────────────────

/**
 * 發現合格 setup 時，記錄晴的模擬看法到 sim_views.jsonl。
 * 不建立 trade journal 條目，只保存「如果要進場，方向/價位/RR 是這樣」的觀點快照。
 */
function logSimView(asset, price, bias, keyLevels, structure, score, grade, bestTf) {
  try {
    if (!bias || bias === "neutral") return;
    const levels = calcSimLevels(price, bias, keyLevels);
    if (levels.rr < 1.0) return; // 太差的 setup 不記

    const obs  = keyLevels?.order_blocks || [];
    const fvgs = keyLevels?.fvgs || [];
    let key_area = "structure";
    if (obs.length > 0)       key_area = "OB";
    else if (fvgs.length > 0) key_area = "FVG";

    const h1 = (structure?.["1H"]) || {};
    const structDesc = h1.trend ? `${h1.trend} | ${(h1.pattern || []).join("/")}` : "multi-TF confluence";

    const view = {
      asset,
      observed_at:   Date.now(),
      price,
      bias,
      direction:     levels.direction,
      entry:         levels.entry,
      stop:          levels.stop,
      target:        levels.target,
      rr:            Number(levels.rr.toFixed(2)),
      score,
      grade,
      best_entry_tf: bestTf || null,
      key_area,
      structure_desc: structDesc,
    };

    fs.mkdirSync(path.dirname(VIEWS_FILE), { recursive: true });
    fs.appendFileSync(VIEWS_FILE, JSON.stringify(view) + "\n", "utf8");
    console.log(`[scheduler] sim view logged: ${asset} ${levels.direction} entry=${levels.entry} stop=${levels.stop} target=${levels.target} RR=${levels.rr.toFixed(2)} score=${score}`);
  } catch { /* non-blocking */ }
}

/**
 * 讀取最近 N 條模擬看法（最新的在前）
 */
function getRecentSimViews(n = 6) {
  try {
    if (!fs.existsSync(VIEWS_FILE)) return [];
    const lines = fs.readFileSync(VIEWS_FILE, "utf8").split("\n").filter(Boolean);
    return lines.slice(-n).reverse().map(l => JSON.parse(l));
  } catch { return []; }
}

// ── 自動反思 + 統計持久化 ────────────────────────────────────────────────────

/**
 * 每 5 筆模擬平倉後，自動觸發 periodicReview + generateHypothesis
 * 結果分別追加到 reviews.jsonl 和 hypotheses.jsonl
 * 背景執行，不阻塞觀察週期
 */
async function triggerPeriodicReview() {
  const closedSim = getClosedTrades().filter(t => t.simulated === true);
  if (closedSim.length < 3) return;

  console.log(`[scheduler] triggering periodic review (${closedSim.length} closed sim trades)`);
  try {
    const review = await periodicReview(closedSim);
    const reviewEntry = JSON.stringify({ timestamp: Date.now(), count: closedSim.length, review }) + "\n";
    fs.mkdirSync(path.dirname(REVIEWS_FILE), { recursive: true });
    fs.appendFileSync(REVIEWS_FILE, reviewEntry);
    console.log("[scheduler] periodic review saved →", REVIEWS_FILE);
  } catch (err) {
    console.error("[scheduler] periodicReview error:", err.message);
  }

  // 假設生成（需 ≥ 5 筆）
  if (closedSim.length >= 5) {
    try {
      const stats = getSimulatedStats();
      const hypothesis = await generateHypothesis(stats, closedSim);
      const hEntry = JSON.stringify({ timestamp: Date.now(), count: closedSim.length, hypothesis }) + "\n";
      fs.appendFileSync(HYPOTHESES_FILE, hEntry);
      console.log("[scheduler] hypothesis saved →", HYPOTHESES_FILE);
    } catch (err) {
      console.error("[scheduler] generateHypothesis error:", err.message);
    }
  }
}

/**
 * 每 10 次觀察觸發一次學習洞察（背景非阻塞）
 * 將近期觀察歷史（含 RSI/KDJ）送入 LLM，尋找指標模式與 DTFX 評分的關聯。
 */
async function triggerObservationInsight() {
  if (_history.length < 5) return;
  console.log(`[scheduler] triggering observation insight (${_history.length} obs total)`);
  try {
    const insight = await generateObservationInsight(_history.slice(-30));
    const iEntry  = JSON.stringify({ timestamp: Date.now(), obs_count: _totalObservations, insight }) + "\n";
    fs.mkdirSync(path.dirname(OBS_INSIGHT_FILE), { recursive: true });
    fs.appendFileSync(OBS_INSIGHT_FILE, iEntry, "utf8");
    console.log("[scheduler] observation insight saved →", OBS_INSIGHT_FILE);
  } catch (err) {
    console.error("[scheduler] observation insight error:", err.message);
  }
}

/**
 * 將模擬交易統計寫入 stats.json（每次觀察週期更新）
 */
function saveStats() {
  try {
    const stats = getSimulatedStats();
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify({ ...stats, updated_at: Date.now() }, null, 2));
  } catch { /* ignore */ }
}

// ── 觀察週期 ──────────────────────────────────────────────────────────────────

async function runObservationCycle() {
  if (!_active) return;

  checkWeeklyReset(); // 每次觀察前檢查是否跨週

  if (!isObservationWindow()) {
    // 永遠不應進入此分支（24/7 模式）
    scheduleNext(5 * 60 * 1000);
    return;
  }

  const intervalMin = _mode === "learned" ? _intervalMin : pickExploreInterval();
  _intervalMin = intervalMin;
  const tw = getTW();
  console.log(`[scheduler] observing (TW ${tw.toLocaleTimeString()}, mode=${_mode}, interval=${intervalMin}min)`);

  let cycleClosedCount = 0;
  let bestCandidate = null;

  for (const asset of ASSETS) {
    try {
      // ── Step 1: 快速掃描（noLLM, 取得價格 + 結構）──────────────────────
      const quick = await observe(asset, { noLLM: true });
      const price  = quick.price;
      const score  = quick.confluence?.avg_setup_score || 0;
      const grade  = quick.setup?.grade || computeGrade(score); // observer grade 優先，否則本地計算
      const bias   = quick.confluence?.overall_bias || "neutral";
      const bestTf = quick.confluence?.best_entry_tf || null;

      // ── 預先計算 RR（用於雙條件判斷）────────────────────────────────────
      const estLevels      = bias !== "neutral" ? calcSimLevels(price, bias, quick.key_levels) : null;
      const estimatedRR    = estLevels?.rr || 0;

      // 開倉條件：score ≥ 60（標準）OR（RR ≥ 2.5 AND score ≥ 45，高盈虧比備用）
      const meetsScore     = score >= SETUP_THRESHOLD;
      const meetsHighRR    = estimatedRR >= HIGH_RR_THRESHOLD && score >= HIGH_RR_MIN_SCORE;
      const shouldOpenSim  = bias !== "neutral" && (meetsScore || meetsHighRR);

      // 用於每日最低倉位挑選最佳候選
      if (bias !== "neutral") {
        if (!bestCandidate || score > bestCandidate.score) {
          bestCandidate = {
            asset,
            price: quick.price,
            bias,
            keyLevels: quick.key_levels,
            structure: quick.structure,
            score,
            grade,
            bestTf,
          };
        }
      }

      // ── Step 2: 監控開放模擬倉位（傳入 high/low 做 K 棒內觸及判斷）──────
      cycleClosedCount += monitorSimTrades(asset, price, quick.high, quick.low);

      // ── Step 3: 記錄觀察歷史 ────────────────────────────────────────────
      const entry = {
        asset, timestamp: Date.now(), score, grade, bias,
        rr: Number(estimatedRR.toFixed(2)),
        best_entry_tf: bestTf, interval_min: intervalMin, price,
        rsi: quick.indicators?.rsi ?? null,
        kdj: quick.indicators?.kdj || null,
      };
      _history.push(entry);
      if (_history.length > 500) _history.splice(0, _history.length - 500);
      _totalObservations++;
      _weeklyObs++;

      if (shouldOpenSim) {
        // ── Step 4a: 符合開倉條件 → 快取、記錄看法、嘗試建倉 ────────────
        const openReason = meetsScore
          ? `score=${score} ≥ 60`
          : `RR=${estimatedRR.toFixed(2)} ≥ ${HIGH_RR_THRESHOLD}（score=${score}）`;
        console.log(`[scheduler] setup [${gradeLabel(grade)}]: ${asset} ${openReason} bias=${bias} — attempting sim open.`);

        try {
          _activeSetups.unshift({
            asset, score, grade, bias, best_entry_tf: bestTf,
            price: quick.price, change_pct: quick.change_pct,
            structure: quick.structure, key_levels: quick.key_levels,
            confluence: quick.confluence, trade_idea: null,
            estimated_rr: Number(estimatedRR.toFixed(2)),
            observed_at: Date.now(),
          });
          if (_activeSetups.length > 10) _activeSetups.splice(10);
          saveActiveSetups();

          // ── Step 4b: 記錄模擬看法快照 ──────────────────────────────────
          logSimView(asset, quick.price, bias, quick.key_levels, quick.structure, score, grade, bestTf);

          // ── Step 4c: 嘗試自動開倉 ─────────────────────────────────────
          await autoOpenSimTrade(
            asset, quick.price, bias,
            quick.key_levels, quick.structure,
            score, grade, bestTf,
            `${gradeLabel(grade)} | ${openReason} | bias=${bias}`,
          );
        } catch (err) {
          console.error(`[scheduler] sim open error for ${asset}:`, err.message);
        }
      } else {
        // ── Step 4d: 不符合條件 — 靜默觀察 ────────────────────────────
        console.log(`[scheduler] watching: ${asset} score=${score} grade=${grade} RR≈${estimatedRR.toFixed(2)} bias=${bias}`);
      }
    } catch (err) {
      console.error(`[scheduler] ${asset} error:`, err.message);
    }
  }

  try {
    await ensureWeekdayDailyMinimumTrade(bestCandidate);
  } catch (err) {
    console.error("[scheduler] daily minimum enforcement failed:", err.message);
  }

  // ── 反思觸發：每 5 筆平倉觸發一次（背景非阻塞）─────────────────────────
  if (cycleClosedCount > 0) {
    _closedSinceLastReview += cycleClosedCount;
    if (_closedSinceLastReview >= 5) {
      _closedSinceLastReview = 0;
      triggerPeriodicReview().catch(err =>
        console.error("[scheduler] periodic review failed:", err.message)
      );
    }
  }

  // 每 30 次觀察更新學習疑問
  if (_history.length > 0 && _history.length % 30 === 0) {
    refreshCuriosity();
  }

  // 每 10 次觀察觸發指標學習洞察（背景非阻塞）
  if (_totalObservations > 0 && _totalObservations % 10 === 0) {
    triggerObservationInsight().catch(err =>
      console.error("[scheduler] observation insight failed:", err.message)
    );
  }

  // 每次觀察週期非同步更新即將到來的事件提示（背景執行）
  refreshAnticipation().catch(() => {});

  tryOptimizeRhythm();
  saveStats();
  saveRhythm();
  scheduleNext(intervalMin * 60 * 1000);
}

function scheduleNext(ms) {
  if (!_active) return;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(runObservationCycle, ms);
}

// ── 情緒 / 進度 / 好奇心 API ──────────────────────────────────────────────────

// 規則生成的學習疑問池（每 30 次觀察輪換）
const CURIOSITY_POOL = [
  "OB 被回測後怎麼判斷它還有沒有效？",
  "FVG 和 OB 同時出現，哪個優先？",
  "BOS 和 CHoCH 確認的時間差對進場影響有多大？",
  "在哪個時間框架下多空方向最容易看清楚？",
  "流動性掃蕩後如果沒有反轉，是市場結構問題還是我判斷錯了？",
  "做多的 SSL 止損水位要設在 swing low 下面多少才合理？",
  "勝率低但 RR 高的策略，實際心理上能持續嗎？",
  "看盤頻率高一點和低一點，對我的模擬勝率有沒有影響？",
  "BSL 被掃之後市場繼續上，這樣算 BOS 嗎？",
  "我的模擬倉位大多是哪個時段虧損的？",
  "入場評分怎麼樣才算真的夠高？",
  "4H 和 1H 的方向衝突的時候，我要怎麼選邊站？",
];

function refreshCuriosity() {
  const idx = Math.floor(Date.now() / 1000 / 300) % CURIOSITY_POOL.length; // 每 5 分鐘換一個候選
  _currentCuriosity = CURIOSITY_POOL[idx];
}

/**
 * 根據近期交易表現生成情緒修飾語（注入所有對話，不限 trading 主題）
 * @returns {string} 修飾語，例如「（最近連輸幾筆，有點煩）」；正常時回傳空字串
 */
function getTradingMoodModifier() {
  if (_consecutiveLosses >= 4) return "（最近連輸幾筆，有點心煩，一直在想哪裡出問題）";
  if (_consecutiveLosses >= 2) return "（最近輸了幾筆模擬，心情有點微妙）";
  if (_consecutiveWins >= 3)   return "（最近幾筆模擬都贏了，心情還不錯）";
  if (_consecutiveWins >= 2)   return "（最近連贏幾筆，對自己的判斷稍微多了點信心）";
  return "";
}

/**
 * 返回晴的學習進度描述（自然語言）
 * @returns {string}
 */
function getLearningProgress() {
  const obs = _totalObservations || _history.length;
  if (!_startedAt) return `學習 DTFX 中，累計觀察 ${obs} 次`;
  const daysElapsed = Math.floor((Date.now() - _startedAt) / (1000 * 60 * 60 * 24));
  if (daysElapsed < 1)  return `剛開始學 DTFX，今天第一天，已觀察 ${obs} 次`;
  if (daysElapsed < 7)  return `學習第 ${daysElapsed} 天，累計觀察 ${obs} 次`;
  if (daysElapsed < 30) return `學習約 ${Math.floor(daysElapsed / 7)} 週（${daysElapsed} 天），累計觀察 ${obs} 次`;
  return `學習約 ${Math.floor(daysElapsed / 30)} 個月，累計觀察 ${obs} 次`;
}

/**
 * 返回當前學習疑問（可能為 null）
 * @returns {string|null}
 */
function getCuriosity() { return _currentCuriosity; }

/**
 * 非同步更新「即將到來的高影響力事件」提示快取（每次觀察週期呼叫）
 * 不阻塞主迴圈 — 失敗時靜默忽略
 */
async function refreshAnticipation() {
  try {
    const { getUpcomingEvents } = require("./news_calendar");
    const upcoming = await getUpcomingEvents(5);
    if (!upcoming || upcoming.length === 0) { _anticipationHint = null; return; }

    const now = Date.now();
    const within30min = upcoming.filter(ev => {
      const t = ev.time ? new Date(ev.time).getTime() : null;
      return t && t > now && t - now <= 30 * 60 * 1000;
    });
    const within2h = upcoming.filter(ev => {
      const t = ev.time ? new Date(ev.time).getTime() : null;
      return t && t > now && t - now <= 2 * 60 * 60 * 1000;
    });

    if (within30min.length > 0) {
      const name = within30min[0].title;
      _anticipationHint = `（${name} 快出了，市場可能會動一下，有點緊張）`;
    } else if (within2h.length >= 2) {
      _anticipationHint = `（今天有幾個重大數據，在注意一下波動）`;
    } else if (within2h.length === 1) {
      const name = within2h[0].title;
      _anticipationHint = `（等一下有 ${name}，我在注意一下）`;
    } else {
      _anticipationHint = null;
    }
  } catch { _anticipationHint = null; }
}

/**
 * 返回即將到來的高影響力事件提示（可能為 null）
 * @returns {string|null}
 */
function getAnticipationHint() { return _anticipationHint; }

// ── 1-minute SL/TP fast monitor ──────────────────────────────────────────────
// Independent of observation cycle — ensures open sim positions are closed
// promptly even when the main cycle interval is 15-30 min.

let _slTpTimer = null;

async function runSLTPMonitor() {
  const open = getOpenSimulatedTrades();
  if (open.length === 0) return;
  const { fetchSnapshot } = require("./tv_datafeed");
  for (const asset of ASSETS) {
    try {
      // fetchSnapshot returns { price (close), high, low, ... } from TV Scanner
      // Using high/low ensures intra-candle SL/TP hits are detected even if
      // price reverts before the candle closes.
      const snap = await fetchSnapshot(asset);
      if (snap && snap.price) {
        monitorSimTrades(asset, snap.price, snap.high ?? snap.price, snap.low ?? snap.price);
      }
    } catch { /* silent */ }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function startScheduler() {
  if (_active) return;
  _active = true;
  loadRhythm();
  loadActiveSetups();
  if (!_startedAt) {
    _startedAt = Date.now();
    saveRhythm();
  }
  checkWeeklyReset(); // 若跨週重啟則自動記錄並重置
  if (!_currentCuriosity) refreshCuriosity();
  console.log(`[scheduler] 晴 trading scheduler started (mode=${_mode}, interval=${_intervalMin}min, started_at=${new Date(_startedAt).toISOString()})`);
  _timer = setTimeout(runObservationCycle, 10 * 1000);
  // Fast SL/TP monitor: every 60 seconds
  _slTpTimer = setInterval(runSLTPMonitor, 60 * 1000);
}

function stopScheduler() {
  _active = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_slTpTimer) { clearInterval(_slTpTimer); _slTpTimer = null; }
  console.log("[scheduler] 晴 trading scheduler stopped.");
}

function getSchedulerStatus() {
  const tw = getTW();
  const hitCount  = _history.filter(h => h.score >= SETUP_THRESHOLD).length;
  const openSims  = getOpenSimulatedTrades().length;
  // Correct slice: when _weeklyObs > _history.length, slice from 0 (not from negative index)
  const weeklySlice = _history.slice(Math.max(0, _history.length - _weeklyObs));
  const weeklyHitCount = weeklySlice.filter(h => h.score >= SETUP_THRESHOLD).length;
  const dayOfWeek = tw.getDay(); // 0=Sun, 6=Sat
  const is_weekend = dayOfWeek === 0 || dayOfWeek === 6;
  return {
    active:               _active,
    in_window:            true, // 24/7
    is_weekend,
    mode:                 _mode,
    current_interval_min: _intervalMin,
    observations_total:   _totalObservations,
    observations_weekly:  _weeklyObs,
    week_start:           _weekStart,
    setup_hits:           hitCount,
    setup_hits_weekly:    weeklyHitCount,
    setup_hit_rate:       _weeklyObs > 0 ? Number((weeklyHitCount / _weeklyObs).toFixed(3)) : 0, // 本週有結構比率
    active_setups:        _activeSetups.length,
    open_sim_trades:      openSims,
    taiwan_time:          tw.toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
    next_window_min:      minutesUntilWindow(),
    recent_obs:           _history.slice(-5).reverse(),
  };
}

function getActiveSetups() { return _activeSetups; }

/**
 * 快速查詢今日高影響力財經事件（供 dashboard 顯示）
 */
async function getNewsStatus() {
  const { getCalendarSummary } = require("./news_calendar");
  return getCalendarSummary().catch(() => ({ count: 0, events: [], error: "fetch failed" }));
}

module.exports = {
  startScheduler, stopScheduler, getSchedulerStatus, getActiveSetups, getNewsStatus,
  getTradingMoodModifier, getLearningProgress, getCuriosity, getAnticipationHint,
  getRecentSimViews,
};
