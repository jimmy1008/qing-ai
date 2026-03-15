"use strict";
// dtfx_analyzer.js — Pure JS DTFX technical analysis engine
//
// Takes OHLCV candle arrays and applies DTFX methodology:
//   1. Swing structure detection (HH/HL/LH/LL)
//   2. BOS / CHoCH identification
//   3. Order Block (OB) detection
//   4. Fair Value Gap (FVG) detection
//   5. Liquidity level mapping (SSL / BSL)
//   6. Setup scoring (0–100)
//
// All analysis is deterministic — no LLM, no side effects.
// DTFX Core logic is immutable; optimization params are passed in.

// ── Config (optimization surface — can be tuned) ─────────────────────────────
const DEFAULT_PARAMS = {
  swing_left:   5,   // bars left of swing pivot
  swing_right:  3,   // bars right of swing pivot (needs this many to confirm)
  fvg_min_pct:  0.10, // FVG minimum size (% of price)
  ob_lookback:  10,  // max bars back to look for OB
  liq_cluster:  0.05, // % tolerance to group equal highs/lows
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Full DTFX analysis on a candle array.
 * @param {Candle[]} candles  — sorted oldest → newest
 * @param {object}  params    — optional override of DEFAULT_PARAMS
 * @returns {DTFXAnalysis}
 */
function analyze(candles, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  if (!candles || candles.length < 20) {
    return { error: "Insufficient candles (need ≥ 20)", candles: candles?.length || 0 };
  }

  const swings    = detectSwings(candles, p);
  const structure = classifyStructure(swings);
  const bos       = detectBOS(candles, swings, structure);
  const choch     = detectCHoCH(candles, swings, structure);
  const obs       = findOrderBlocks(candles, bos, p);
  const fvgs      = findFVGs(candles, p);
  const liq       = findLiquidityLevels(candles, p);
  const currentPrice = candles[candles.length - 1].close;
  const setup     = scoreSetup(structure, bos, choch, obs, fvgs, liq, currentPrice);

  return {
    candles_analyzed: candles.length,
    current_price:    currentPrice,
    structure,
    latest_bos:       bos.length   ? bos[bos.length - 1]   : null,
    latest_choch:     choch.length ? choch[choch.length - 1] : null,
    order_blocks:     obs,
    fvgs,
    liquidity:        liq,
    setup,
  };
}

/**
 * Multi-timeframe confluence analysis.
 * @param {{ "4H": Candle[], "1H": Candle[], "15M": Candle[], "5M": Candle[] }} multiTFData
 * @returns {MTFAnalysis}
 */
function analyzeMultiTF(multiTFData) {
  const results = {};
  for (const [tf, candles] of Object.entries(multiTFData)) {
    if (candles && candles.length >= 20) {
      results[tf] = analyze(candles);
    } else {
      results[tf] = { error: "No data", candles: candles?.length || 0 };
    }
  }

  // Build confluence summary
  const confluence = buildConfluence(results);
  return { timeframes: results, confluence };
}

// ── Swing detection ───────────────────────────────────────────────────────────

function detectSwings(candles, p) {
  const highs = [];
  const lows  = [];
  const { swing_left: L, swing_right: R } = p;

  for (let i = L; i < candles.length - R; i++) {
    const slice_h = candles.slice(i - L, i + R + 1).map(c => c.high);
    const slice_l = candles.slice(i - L, i + R + 1).map(c => c.low);
    const pivot_h = candles[i].high;
    const pivot_l = candles[i].low;

    if (pivot_h === Math.max(...slice_h)) {
      highs.push({ index: i, price: pivot_h, time: candles[i].time });
    }
    if (pivot_l === Math.min(...slice_l)) {
      lows.push({ index: i, price: pivot_l, time: candles[i].time });
    }
  }

  return { highs, lows };
}

// ── Structure classification ──────────────────────────────────────────────────

function classifyStructure(swings) {
  const { highs, lows } = swings;
  if (highs.length < 2 || lows.length < 2) {
    return { trend: "undefined", pattern: [], last_high: null, last_low: null };
  }

  const recentHighs = highs.slice(-3);
  const recentLows  = lows.slice(-3);

  // Check HH/HL = uptrend
  const hh = recentHighs.length >= 2 && recentHighs[recentHighs.length-1].price > recentHighs[recentHighs.length-2].price;
  const hl = recentLows.length  >= 2 && recentLows[recentLows.length-1].price  > recentLows[recentLows.length-2].price;
  // Check LH/LL = downtrend
  const lh = recentHighs.length >= 2 && recentHighs[recentHighs.length-1].price < recentHighs[recentHighs.length-2].price;
  const ll = recentLows.length  >= 2 && recentLows[recentLows.length-1].price  < recentLows[recentLows.length-2].price;

  let trend = "ranging";
  const pattern = [];
  if (hh) pattern.push("HH");
  if (hl) pattern.push("HL");
  if (lh) pattern.push("LH");
  if (ll) pattern.push("LL");

  if (hh && hl) trend = "bullish";
  else if (lh && ll) trend = "bearish";
  else if (hh && ll) trend = "distribution";
  else if (lh && hl) trend = "accumulation";

  return {
    trend,
    pattern,
    last_high:      recentHighs[recentHighs.length - 1] || null,
    last_low:       recentLows[recentLows.length - 1]   || null,
    recent_highs:   recentHighs,   // [ { index, price, time }, ... ] last 3
    recent_lows:    recentLows,    // [ { index, price, time }, ... ] last 3
  };
}

// ── BOS detection ─────────────────────────────────────────────────────────────

function detectBOS(candles, swings, structure) {
  const bos = [];
  const { highs, lows } = swings;

  // Bullish BOS: close breaks above a prior swing high
  for (let i = 1; i < candles.length; i++) {
    const prevHighs = highs.filter(h => h.index < i - 1);
    if (!prevHighs.length) continue;
    const lastHigh = prevHighs[prevHighs.length - 1];

    if (candles[i].close > lastHigh.price &&
        candles[i - 1].close <= lastHigh.price) {
      bos.push({
        type:      "bullish_BOS",
        level:     lastHigh.price,
        candle_idx: i,
        time:      candles[i].time,
        broke_high: lastHigh.price,
      });
    }
  }

  // Bearish BOS: close breaks below a prior swing low
  for (let i = 1; i < candles.length; i++) {
    const prevLows = lows.filter(l => l.index < i - 1);
    if (!prevLows.length) continue;
    const lastLow = prevLows[prevLows.length - 1];

    if (candles[i].close < lastLow.price &&
        candles[i - 1].close >= lastLow.price) {
      bos.push({
        type:      "bearish_BOS",
        level:     lastLow.price,
        candle_idx: i,
        time:      candles[i].time,
        broke_low:  lastLow.price,
      });
    }
  }

  return bos.sort((a, b) => a.candle_idx - b.candle_idx);
}

// ── CHoCH detection ───────────────────────────────────────────────────────────

function detectCHoCH(candles, swings, structure) {
  const choch = [];

  // CHoCH: in a downtrend, a close above a prior lower high (bullish flip)
  //        in an uptrend, a close below a prior higher low (bearish flip)
  if (structure.trend === "bearish" && swings.highs.length >= 2) {
    const highs = swings.highs;
    for (let i = 1; i < candles.length; i++) {
      const prevHighs = highs.filter(h => h.index < i);
      if (prevHighs.length < 2) continue;
      const lastLH = prevHighs[prevHighs.length - 1];
      if (candles[i].close > lastLH.price && candles[i-1].close <= lastLH.price) {
        choch.push({ type: "bullish_CHoCH", level: lastLH.price, candle_idx: i, time: candles[i].time });
      }
    }
  }

  if (structure.trend === "bullish" && swings.lows.length >= 2) {
    const lows = swings.lows;
    for (let i = 1; i < candles.length; i++) {
      const prevLows = lows.filter(l => l.index < i);
      if (prevLows.length < 2) continue;
      const lastHL = prevLows[prevLows.length - 1];
      if (candles[i].close < lastHL.price && candles[i-1].close >= lastHL.price) {
        choch.push({ type: "bearish_CHoCH", level: lastHL.price, candle_idx: i, time: candles[i].time });
      }
    }
  }

  return choch.sort((a, b) => a.candle_idx - b.candle_idx);
}

// ── Order Block detection ─────────────────────────────────────────────────────

function findOrderBlocks(candles, bos, p) {
  const obs = [];
  const { ob_lookback } = p;

  for (const b of bos) {
    const start = Math.max(0, b.candle_idx - ob_lookback);

    if (b.type === "bullish_BOS") {
      // Last bearish (down) candle before bullish BOS = bearish OB that price may return to
      for (let i = b.candle_idx - 1; i >= start; i--) {
        const c = candles[i];
        if (c.close < c.open) { // bearish candle
          obs.push({
            type:      "bullish_OB",      // price returns to test this from above
            direction: "long_bias",
            top:       c.open,
            bottom:    c.close,
            mid:       (c.open + c.close) / 2,
            formed_at: c.time,
            bos_time:  b.time,
          });
          break;
        }
      }
    }

    if (b.type === "bearish_BOS") {
      // Last bullish (up) candle before bearish BOS = bullish OB that price may return to
      for (let i = b.candle_idx - 1; i >= start; i--) {
        const c = candles[i];
        if (c.close > c.open) { // bullish candle
          obs.push({
            type:      "bearish_OB",
            direction: "short_bias",
            top:       c.close,
            bottom:    c.open,
            mid:       (c.open + c.close) / 2,
            formed_at: c.time,
            bos_time:  b.time,
          });
          break;
        }
      }
    }
  }

  // Return only OBs that haven't been fully engulfed (still valid)
  const currentPrice = candles[candles.length - 1].close;
  return obs.filter(ob => {
    if (ob.direction === "long_bias")  return currentPrice > ob.bottom * 0.995; // not fully swept
    if (ob.direction === "short_bias") return currentPrice < ob.top   * 1.005;
    return true;
  }).slice(-4); // keep last 4 valid OBs
}

// ── FVG detection ─────────────────────────────────────────────────────────────

function findFVGs(candles, p) {
  const fvgs = [];
  const minSize = p.fvg_min_pct / 100;

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // Bullish FVG: gap between prev.high and next.low (price moves up fast)
    if (next.low > prev.high) {
      const size = (next.low - prev.high) / curr.close;
      if (size >= minSize) {
        fvgs.push({
          type:      "bullish_FVG",
          top:       next.low,
          bottom:    prev.high,
          mid:       (next.low + prev.high) / 2,
          size_pct:  Number((size * 100).toFixed(3)),
          formed_at: curr.time,
        });
      }
    }

    // Bearish FVG: gap between next.high and prev.low (price moves down fast)
    if (next.high < prev.low) {
      const size = (prev.low - next.high) / curr.close;
      if (size >= minSize) {
        fvgs.push({
          type:      "bearish_FVG",
          top:       prev.low,
          bottom:    next.high,
          mid:       (prev.low + next.high) / 2,
          size_pct:  Number((size * 100).toFixed(3)),
          formed_at: curr.time,
        });
      }
    }
  }

  // Return recent unfilled FVGs only — check if current price has closed inside
  const currentPrice = candles[candles.length - 1].close;
  return fvgs.filter(fvg => {
    // FVG "filled" if price closed inside the gap
    const lastCandle = candles[candles.length - 1];
    if (fvg.type === "bullish_FVG") return lastCandle.low > fvg.bottom;  // not yet pulled back into
    if (fvg.type === "bearish_FVG") return lastCandle.high < fvg.top;
    return true;
  }).slice(-5);
}

// ── Liquidity levels ──────────────────────────────────────────────────────────

function findLiquidityLevels(candles, p) {
  const tol = p.liq_cluster / 100;

  // Cluster equal highs (BSL — buy-side liquidity above)
  const highs = candles.slice(-50).map(c => c.high).sort((a,b) => b - a);
  const lows  = candles.slice(-50).map(c => c.low).sort((a,b) => a - b);

  const bsl = clusterLevels(highs, tol).slice(0, 3).map(l => ({ type: "BSL", level: l }));
  const ssl = clusterLevels(lows,  tol).slice(0, 3).map(l => ({ type: "SSL", level: l }));

  // Equilibrium (50% of the most recent significant range)
  const recentHigh = Math.max(...candles.slice(-30).map(c => c.high));
  const recentLow  = Math.min(...candles.slice(-30).map(c => c.low));
  const eq = (recentHigh + recentLow) / 2;

  return { bsl, ssl, equilibrium: Number(eq.toFixed(2)), range: { high: recentHigh, low: recentLow } };
}

function clusterLevels(prices, tol) {
  const clusters = [];
  for (const p of prices) {
    if (!p) continue; // skip zero/null to avoid division-by-zero
    const existing = clusters.find(c => c !== 0 && Math.abs(c - p) / p < tol);
    if (!existing) clusters.push(p);
  }
  return clusters;
}

// ── Setup scoring ─────────────────────────────────────────────────────────────

function scoreSetup(structure, bos, choch, obs, fvgs, liq, currentPrice) {
  let score = 0;
  const signals = [];
  const warnings = [];

  // Clear trend direction
  if (structure.trend === "bullish" || structure.trend === "bearish") {
    score += 20;
    signals.push(`clear ${structure.trend} trend (${structure.pattern.join("/")})`);
  } else {
    warnings.push(`ranging / unclear structure (${structure.trend})`);
  }

  // Recent BOS
  const recentBOS = bos.slice(-2);
  if (recentBOS.length > 0) {
    score += 15;
    signals.push(`recent BOS: ${recentBOS[recentBOS.length-1].type}`);
  }

  // CHoCH present
  if (choch.length > 0) {
    score += 10;
    signals.push(`CHoCH detected: ${choch[choch.length-1].type}`);
  }

  // Valid OB near current price (within 2%)
  const nearOB = obs.filter(ob => {
    const distTop    = Math.abs(currentPrice - ob.top)    / currentPrice;
    const distBottom = Math.abs(currentPrice - ob.bottom) / currentPrice;
    return Math.min(distTop, distBottom) < 0.02;
  });
  if (nearOB.length > 0) {
    score += 25;
    signals.push(`OB within 2% of price (${nearOB[0].type})`);
  }

  // Unfilled FVG near current price (within 1.5%)
  const nearFVG = fvgs.filter(fvg => {
    const dist = Math.abs(currentPrice - fvg.mid) / currentPrice;
    return dist < 0.015;
  });
  if (nearFVG.length > 0) {
    score += 15;
    signals.push(`open FVG within 1.5% of price (${nearFVG[0].type})`);
  }

  // SSL/BSL near price (liquidity magnet)
  const allLiqLevels = [...(liq.bsl || []), ...(liq.ssl || [])];
  const nearLiq = allLiqLevels.filter(l => Math.abs(l.level - currentPrice) / currentPrice < 0.01);
  if (nearLiq.length > 0) {
    score += 15;
    signals.push(`liquidity pool within 1% (${nearLiq.map(l=>l.type).join(",")})`);
  }

  // Penalty: price at premium/discount extremes without OB
  if (nearOB.length === 0 && nearFVG.length === 0) {
    warnings.push("no OB or FVG near current price — wait for pullback");
  }

  const bias = deriveBias(structure, bos, choch, currentPrice, liq);

  return {
    score:    Math.min(100, score),
    grade:    score >= 70 ? "A" : score >= 50 ? "B" : score >= 30 ? "C" : "D",
    bias,
    signals,
    warnings,
    near_ob:  nearOB,
    near_fvg: nearFVG,
  };
}

function deriveBias(structure, bos, choch, price, liq) {
  // Most recent BOS or CHoCH determines current directional bias
  const allEvents = [
    ...bos.map(b => ({ ...b, is_choch: false })),
    ...choch.map(c => ({ ...c, is_choch: true })),
  ].sort((a,b) => a.candle_idx - b.candle_idx);

  if (!allEvents.length) return structure.trend === "bullish" ? "long" : structure.trend === "bearish" ? "short" : "neutral";

  const last = allEvents[allEvents.length - 1];
  if (last.type?.includes("bullish")) return "long";
  if (last.type?.includes("bearish")) return "short";
  return "neutral";
}

// ── Confluence builder ────────────────────────────────────────────────────────

function buildConfluence(results) {
  const tfs = ["4H", "1H", "15M", "5M"];
  const biases   = {};
  const scores   = {};
  const trends   = {};

  for (const tf of tfs) {
    const r = results[tf];
    if (r?.error) continue;
    biases[tf] = r.setup?.bias;
    scores[tf] = r.setup?.score;
    trends[tf] = r.structure?.trend;
  }

  // Count direction confluence
  const biasArr = Object.values(biases).filter(Boolean);
  const longCount  = biasArr.filter(b => b === "long").length;
  const shortCount = biasArr.filter(b => b === "short").length;
  const totalBias  = biasArr.length;

  let overallBias = "neutral";
  if (longCount / totalBias >= 0.75) overallBias = "strong_long";
  else if (shortCount / totalBias >= 0.75) overallBias = "strong_short";
  else if (longCount > shortCount) overallBias = "lean_long";
  else if (shortCount > longCount) overallBias = "lean_short";

  // Average setup score weighted (higher TF = more weight)
  const weights = { "4H": 3, "1H": 2, "15M": 1, "5M": 0.5 };
  let totalWeight = 0, weightedScore = 0;
  for (const [tf, score] of Object.entries(scores)) {
    if (score != null) {
      weightedScore += score * (weights[tf] || 1);
      totalWeight   += (weights[tf] || 1);
    }
  }
  const avgScore = totalWeight ? Math.round(weightedScore / totalWeight) : 0;

  // Best entry TF: prefer lower TFs for precision, but accept any TF ≥ 50
  const TF_PRIORITY = ["15M", "5M", "1H", "4H"];
  const bestEntryTF = TF_PRIORITY.find(tf => (scores[tf] ?? 0) >= 50) || null;

  return {
    overall_bias:    overallBias,
    avg_setup_score: avgScore,
    best_entry_tf:   bestEntryTF,
    tf_biases:       biases,
    tf_scores:       scores,
    tf_trends:       trends,
  };
}

module.exports = { analyze, analyzeMultiTF, DEFAULT_PARAMS };
