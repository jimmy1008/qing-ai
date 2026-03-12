"use strict";
// DTFX Core — Immutable strategy knowledge base
// DO NOT MODIFY core structure. Optimization Surface (params) is in DTFX_PARAMS.
//
// DTFX = 晴的主要交易方法。核心邏輯不得修改。
// 可調整的參數放在 DTFX_PARAMS，晴可以在這裡學習與優化。

// ── Core Concepts (immutable) ─────────────────────────────────────────────────

const DTFX_CORE = Object.freeze({

  // Market structure classification
  market_structure: Object.freeze({
    BOS:  "Break of Structure — 市場結構突破，方向確認",
    CHoCH: "Change of Character — 結構轉變，可能趨勢反轉",
    HH:   "Higher High — 上升趨勢更高的高點",
    HL:   "Higher Low  — 上升趨勢更高的低點",
    LH:   "Lower High  — 下降趨勢更低的高點",
    LL:   "Lower Low   — 下降趨勢更低的低點",
  }),

  // Key areas where price is likely to react
  key_areas: Object.freeze({
    OB:   "Order Block — 機構訂單集中的K棒，通常在BOS前的最後一根反向K",
    FVG:  "Fair Value Gap (Imbalance) — 三根K棒之間的不平衡缺口，價格傾向回補",
    SSL:  "Sell-Side Liquidity — 前期低點下方的止損池，誘空後反彈",
    BSL:  "Buy-Side Liquidity  — 前期高點上方的止損池，誘多後回落",
    EQ:   "Equilibrium — 50% of the range，均衡回調區",
    POI:  "Point of Interest — 以上任一關鍵區域",
  }),

  // Valid entry conditions (must meet at least one)
  entry_conditions: Object.freeze({
    touch_entry:          "價格直接觸及 POI 入場，速度快但風險略高",
    confirmation_entry:   "等待 POI 反應信號（反轉K、吞噬、engulfing）再入場",
    structure_confirmation: "等待更低時框 CHoCH/BOS 確認後入場，最保守",
  }),

  // Stop loss placement rules
  sl_types: Object.freeze({
    structure_SL:  "止損放在結構關鍵點外側（OB低點/FVG邊緣）",
    buffer_SL:     "在結構 SL 外再加固定緩衝（例如 0.1%）",
    ATR_SL:        "以 ATR 倍數設定止損距離，適應波動率",
  }),

  // Take profit methods
  tp_types: Object.freeze({
    fixed_RR:        "固定風報比（例 1:2, 1:3），紀律性強",
    liquidity_target: "止盈目標設在對側流動性（SSL/BSL），貼近機構意圖",
    partial_TP:      "分批止盈（例 1:1 出 50%，剩餘持倉至流動性目標）",
  }),

  // Risk management rules — NEVER violated
  risk_rules: Object.freeze([
    "每筆交易最大虧損不超過帳戶 1%",
    "同時開倉不超過 2 筆",
    "禁止在重大消息前後 30 分鐘入場",
    "止損必須在入場前確定",
    "不追單、不在沒有 setup 的情況下入場",
  ]),

  // Session characteristics
  sessions: Object.freeze({
    asia: {
      name: "亞洲盤",
      hours_utc: "00:00–08:00",
      characteristics: "通常區間盤整，噪音較多，掃除前日高低點後反向",
      dtfx_suitability: "中等 — 適合觀察流動性位置，入場謹慎",
    },
    london: {
      name: "倫敦盤",
      hours_utc: "07:00–16:00",
      characteristics: "趨勢性最強，BOS/CHoCH 最清晰，主力動向明確",
      dtfx_suitability: "最佳 — DTFX 效果最好的時段",
    },
    new_york: {
      name: "紐約盤",
      hours_utc: "13:00–22:00",
      characteristics: "波動率高，經常有假突破，與倫敦盤重疊時動能最強",
      dtfx_suitability: "好 — 重疊時段尤佳，單獨使用需謹慎",
    },
  }),

  // Optimization surface — parameters 晴可以學習與調整
  optimization_surface: Object.freeze([
    "session_filter",       // 哪個 session 表現最好
    "entry_confirmation",   // touch / confirmation / structure 哪種勝率更高
    "sl_buffer",            // buffer SL 的最佳緩衝距離
    "tp_logic",             // fixed RR vs liquidity target vs partial TP
    "pair_selection",       // BTC/ETH/主流幣 哪個更適合 DTFX
    "auxiliary_filters",    // funding rate / OI / volume 輔助過濾效果
  ]),
});

// ── Setup Checklist ───────────────────────────────────────────────────────────
// A valid DTFX setup requires ALL of:
function validateSetup(setup) {
  const errors = [];
  if (!setup.pair)       errors.push("缺少交易對");
  if (!setup.direction)  errors.push("缺少方向 (long/short)");
  if (!setup.structure)  errors.push("缺少結構分析 (BOS/CHoCH/trend)");
  if (!setup.key_area)   errors.push("缺少關鍵區域 (OB/FVG/SSL/BSL)");
  if (!setup.entry_type) errors.push("缺少入場類型");
  if (!setup.entry)      errors.push("缺少入場價格");
  if (!setup.stop)       errors.push("缺少止損價格");
  if (!setup.target)     errors.push("缺少止盈目標");

  const rr = setup.direction === "long"
    ? (setup.target - setup.entry) / (setup.entry - setup.stop)
    : (setup.entry - setup.target) / (setup.stop - setup.entry);

  if (rr < 1.5) errors.push(`風報比 ${rr.toFixed(2)} 過低（最低 1.5:1）`);

  return { valid: errors.length === 0, errors, rr: Number(rr.toFixed(2)) };
}

module.exports = { DTFX_CORE, validateSetup };
