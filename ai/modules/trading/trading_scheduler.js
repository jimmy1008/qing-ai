"use strict";
// trading_scheduler.js — 晴的自主看盤排程器
//
// 規則：
//   1. 看盤時間：週一至週五 08:00–22:00 台灣時間（UTC+8）
//   2. 週末完全停止市場分析（但可回顧歷史）
//   3. 初期自由探索看盤頻率（10/15/30/60 分鐘之間）
//   4. 累積足夠觀察後自動優化頻率（找到最高 setup 命中率的間隔）
//   5. 發現合格 setup → 生成 LLM 交易想法 + 存入 activeSetups
//   6. 無 setup → 靜默觀察，不強行分析

const path = require("path");
const fs   = require("fs");
const { observe } = require("./market_observer");

// ── 常數 ──────────────────────────────────────────────────────────────────────

const ASSETS = ["BTC", "ETH"];

// 台灣時間看盤窗口
const WINDOW_START = 8;   // 08:00 台灣時間
const WINDOW_END   = 22;  // 22:00 台灣時間（不含）

// 探索模式可選間隔（分鐘）— 晴自己摸索節奏
const EXPLORE_INTERVALS = [10, 15, 30, 60];
const DEFAULT_INTERVAL  = 30; // 初始預設

// 累積多少次觀察後嘗試優化頻率
const MIN_OBS_TO_OPTIMIZE = 30;

// Setup 評分門檻（高於此值才算「有機會」）
const SETUP_THRESHOLD = 60;

// 節奏記憶檔案
const RHYTHM_FILE = path.join(__dirname, "../../../memory/trades/rhythm.json");

// ── 狀態 ──────────────────────────────────────────────────────────────────────

let _active      = false;
let _timer       = null;
let _mode        = "exploring";  // "exploring" | "learned"
let _intervalMin = DEFAULT_INTERVAL;

// 觀察歷史紀錄（最多 100 筆）
const _history = [];

// 近期合格 setup（最多 10 筆）
const _activeSetups = [];

// ── 台灣時間工具 ───────────────────────────────────────────────────────────────

function getTaiwanTime() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
}

/**
 * 是否在有效看盤時間（台灣時間 08:00–22:00，週一至週五）
 */
function isObservationWindow() {
  const tw  = getTaiwanTime();
  const day  = tw.getDay();  // 0=Sun, 6=Sat
  const hour = tw.getHours();
  if (day === 0 || day === 6) return false;
  return hour >= WINDOW_START && hour < WINDOW_END;
}

/**
 * 距離下一個看盤窗口開始還有幾分鐘（已在窗口內則回傳 0）
 */
function minutesUntilWindow() {
  if (isObservationWindow()) return 0;
  const tw   = getTaiwanTime();
  const day  = tw.getDay();
  const hour = tw.getHours();
  const min  = tw.getMinutes();
  const elapsed = hour * 60 + min;

  // 當天窗口尚未開始（平日 00:00–07:59）
  if (day >= 1 && day <= 5 && hour < WINDOW_START) {
    return WINDOW_START * 60 - elapsed;
  }

  // 當天窗口已結束，計算到隔天（或下週一）08:00
  const remainToday = 24 * 60 - elapsed;
  const toNextMorning = remainToday + WINDOW_START * 60;

  if (day === 5) return toNextMorning + 2 * 24 * 60; // 週五結束 → 週一
  if (day === 6) return toNextMorning + 1 * 24 * 60; // 週六     → 週一
  // 週日：toLocaleString 週日=0，此時 day===0
  if (day === 0) return toNextMorning;
  // 平日結束
  return toNextMorning;
}

// ── 節奏持久化 ────────────────────────────────────────────────────────────────

function loadRhythm() {
  try {
    if (!fs.existsSync(RHYTHM_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(RHYTHM_FILE, "utf8"));
    _mode        = saved.mode     || "exploring";
    _intervalMin = saved.interval || DEFAULT_INTERVAL;
    if (Array.isArray(saved.history)) {
      _history.push(...saved.history.slice(-50));
    }
    console.log(`[scheduler] 晴 rhythm loaded: mode=${_mode} interval=${_intervalMin}min history=${_history.length}`);
  } catch { /* 從頭開始 */ }
}

function saveRhythm() {
  try {
    fs.mkdirSync(path.dirname(RHYTHM_FILE), { recursive: true });
    fs.writeFileSync(RHYTHM_FILE, JSON.stringify({
      mode:     _mode,
      interval: _intervalMin,
      history:  _history.slice(-50),
      saved_at: Date.now(),
    }, null, 2));
  } catch { /* ignore */ }
}

// ── 頻率自我優化 ───────────────────────────────────────────────────────────────

/**
 * 探索模式：從可選間隔中挑選，前期偏向預設值，後期加入隨機性
 */
function pickExploreInterval() {
  const obs = _history.length;
  if (obs < 5) return DEFAULT_INTERVAL;

  // 根據各間隔的歷史命中率加權選擇
  const hits  = {};
  const total = {};
  for (const h of _history) {
    const k = String(h.interval_min);
    total[k] = (total[k] || 0) + 1;
    if (h.score >= SETUP_THRESHOLD) hits[k] = (hits[k] || 0) + 1;
  }

  // 計算每個選項的加權得分（有命中率則加分，否則均等）
  const weights = EXPLORE_INTERVALS.map(iv => {
    const k = String(iv);
    const n = total[k] || 0;
    const h = hits[k]  || 0;
    const rate = n > 0 ? h / n : 0.5; // 沒資料預設 50% 探索機率
    return { iv, weight: 1 + rate * 2 };
  });

  const totalWeight = weights.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * totalWeight;
  for (const { iv, weight } of weights) {
    r -= weight;
    if (r <= 0) return iv;
  }
  return EXPLORE_INTERVALS[EXPLORE_INTERVALS.length - 1];
}

/**
 * 嘗試根據歷史資料優化看盤頻率（需 MIN_OBS_TO_OPTIMIZE 筆觀察）
 */
function tryOptimizeRhythm() {
  if (_mode === "learned") return;
  if (_history.length < MIN_OBS_TO_OPTIMIZE) return;

  const recent = _history.slice(-MIN_OBS_TO_OPTIMIZE);
  const hits   = {};
  const total  = {};
  for (const h of recent) {
    const k = String(h.interval_min);
    total[k] = (total[k] || 0) + 1;
    if (h.score >= SETUP_THRESHOLD) hits[k] = (hits[k] || 0) + 1;
  }

  let bestRate     = -1;
  let bestInterval = _intervalMin;
  for (const k of Object.keys(total)) {
    if (total[k] < 3) continue; // 樣本數不足
    const rate = (hits[k] || 0) / total[k];
    if (rate > bestRate) { bestRate = rate; bestInterval = Number(k); }
  }

  if (bestInterval !== _intervalMin || _mode !== "learned") {
    console.log(
      `[scheduler] 晴 rhythm optimized: ${_intervalMin}min → ${bestInterval}min` +
      ` (setup rate ${(bestRate * 100).toFixed(0)}% over last ${MIN_OBS_TO_OPTIMIZE} obs)`
    );
    _intervalMin = bestInterval;
    _mode        = "learned";
    saveRhythm();
  }
}

// ── 觀察週期 ──────────────────────────────────────────────────────────────────

async function runObservationCycle() {
  if (!_active) return;

  // 不在看盤時間 → 等到下個窗口
  if (!isObservationWindow()) {
    const waitMin = Math.max(minutesUntilWindow(), 5);
    const tw      = getTaiwanTime();
    console.log(
      `[scheduler] 晴 off-hours (TW ${tw.toLocaleTimeString()}, ` +
      `${tw.getDay() === 0 || tw.getDay() === 6 ? "weekend" : "after hours"}).` +
      ` Next window in ~${waitMin}min.`
    );
    scheduleNext(waitMin * 60 * 1000);
    return;
  }

  // 決定本輪間隔
  const intervalMin = _mode === "learned" ? _intervalMin : pickExploreInterval();
  _intervalMin = intervalMin;

  const tw = getTaiwanTime();
  console.log(
    `[scheduler] 晴 observing (TW ${tw.toLocaleTimeString()}, ` +
    `mode=${_mode}, interval=${intervalMin}min)`
  );

  for (const asset of ASSETS) {
    try {
      // ── 第一輪：快速掃描（不叫 LLM）────────────────────────────────────
      const quick = await observe(asset, { noLLM: true });
      const score = quick.confluence?.avg_setup_score || 0;
      const grade = quick.setup?.grade   || "D";
      const bias  = quick.confluence?.overall_bias || "neutral";
      const bestTf = quick.confluence?.best_entry_tf || null;

      const entry = {
        asset,
        timestamp:    Date.now(),
        score,
        grade,
        bias,
        best_entry_tf: bestTf,
        interval_min: intervalMin,
        price:        quick.price,
      };
      _history.push(entry);
      if (_history.length > 100) _history.splice(0, _history.length - 100);

      if (score >= SETUP_THRESHOLD) {
        // ── 第二輪：有 setup → 呼叫 LLM 生成交易想法 ──────────────────
        console.log(`[scheduler] 晴 setup found: ${asset} score=${score} grade=${grade} bias=${bias} → generating trade idea...`);
        try {
          const full = await observe(asset, { noLLM: false });
          _activeSetups.unshift({
            asset,
            score,
            grade,
            bias,
            best_entry_tf:  bestTf,
            price:          full.price,
            change_pct:     full.change_pct,
            structure:      full.structure,
            key_levels:     full.key_levels,
            confluence:     full.confluence,
            trade_idea:     full.trade_idea,
            observed_at:    Date.now(),
          });
          if (_activeSetups.length > 10) _activeSetups.splice(10);
        } catch (err) {
          console.error(`[scheduler] LLM trade idea failed for ${asset}:`, err.message);
          // 存 quick 結果不含 trade_idea
          _activeSetups.unshift({ ...entry, trade_idea: null, observed_at: Date.now() });
          if (_activeSetups.length > 10) _activeSetups.splice(10);
        }
      } else {
        // 無 setup — 靜默記錄
        console.log(`[scheduler] 晴 no setup: ${asset} score=${score} grade=${grade} bias=${bias} — watching.`);
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

/**
 * 啟動排程器（server 啟動後呼叫）
 */
function startScheduler() {
  if (_active) return;
  _active = true;
  loadRhythm();
  console.log(`[scheduler] 晴 trading scheduler started (mode=${_mode}, interval=${_intervalMin}min)`);
  // 10 秒後第一次執行（讓 server 先熱機）
  _timer = setTimeout(runObservationCycle, 10 * 1000);
}

/**
 * 停止排程器
 */
function stopScheduler() {
  _active = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  console.log("[scheduler] 晴 trading scheduler stopped.");
}

/**
 * 查詢排程器狀態
 */
function getSchedulerStatus() {
  const tw = getTaiwanTime();
  const today = tw.getDay();
  const isWeekend = today === 0 || today === 6;
  const hitCount = _history.filter(h => h.score >= SETUP_THRESHOLD).length;

  return {
    active:            _active,
    in_window:         isObservationWindow(),
    is_weekend:        isWeekend,
    mode:              _mode,
    current_interval_min: _intervalMin,
    observations_total:   _history.length,
    setup_hits:           hitCount,
    setup_hit_rate:       _history.length > 0 ? Number((hitCount / _history.length).toFixed(3)) : 0,
    active_setups:        _activeSetups.length,
    taiwan_time:          tw.toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
    next_window_min:      minutesUntilWindow(),
    recent_obs:           _history.slice(-5).reverse(),
  };
}

/**
 * 取得近期合格 setup 列表
 */
function getActiveSetups() {
  return _activeSetups;
}

module.exports = { startScheduler, stopScheduler, getSchedulerStatus, getActiveSetups };
