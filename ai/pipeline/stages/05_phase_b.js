"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { getIdentityTruth, savePersonImpression } = require("../../memory_store");
const { getFamiliarityBand } = require("../../familiarity_engine");
const { getCurrentMood } = require("../../mood_engine");
const { getInertiaState } = require("../../inertia_engine");
const { getEmotionalResidue } = require("../../emotional_residue");
const { getCurrentActivity } = require("../../daily_activity");
const { recordMessage: recordTopicHeat, getHeatModifier } = require("../../topic_heat");

const { fetchSnapshot } = require("../../modules/trading/tv_datafeed");

// Matches requests for a chart screenshot in a trading context
const CHART_RE = /截圖|給我看|看圖|圖表|在哪|哪裡|位置|chart|show.?me|看一下圖/i;
// Maps interval strings mentioned by user to TradingView resolution codes
function detectInterval(text) {
  if (/4h|4小時/i.test(text)) return "240";
  if (/15m|15分/i.test(text)) return "15";
  if (/5m|5分/i.test(text))  return "5";
  return "60"; // default: 1H
}
function detectAsset(text) {
  return /eth/i.test(text) ? "ETH" : "BTC";
}
const {
  getSchedulerStatus,
  getTradingMoodModifier,
  getLearningProgress,
  getCuriosity,
  getAnticipationHint,
  getRecentSimViews,
} = require("../../modules/trading/trading_scheduler");
const { getOpenTrades, getOpenSimulatedTrades } = require("../../modules/trading/trade_journal");

const TRADES_MEM = path.join(__dirname, "../../../memory/trades");
const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
const fastModel = process.env.LLM_FAST_MODEL || "qwen2.5:3b";

function buildTradingSelfContext() {
  const parts = [];
  parts.push("交易方法：DTFX + OB/FVG/BOS-CHOCH。實盤未啟動，模擬觀察中。");

  try {
    const statsPath = path.join(TRADES_MEM, "stats.json");
    if (fs.existsSync(statsPath)) {
      const s = JSON.parse(fs.readFileSync(statsPath, "utf8"));
      if (s.total > 0) {
        parts.push(`歷史交易 ${s.total} 筆，勝率 ${s.winRate}% ，平均 RR ${s.avgRR}`);
      } else {
        parts.push("目前為 0 筆實盤，仍在觀察與假設驗證階段。");
      }
    }
  } catch { /* ignore */ }

  try {
    const progress = getLearningProgress();
    if (progress) parts.push(progress);
  } catch { /* ignore */ }

  try {
    const sched = getSchedulerStatus();
    if (sched.active) {
      parts.push(`排程運行中：${sched.current_interval_min} 分鐘/次，累計觀察 ${sched.observations_total}，命中 ${sched.setup_hits}`);
    }
  } catch { /* ignore */ }

  try {
    const reviewPath = path.join(TRADES_MEM, "reviews.jsonl");
    if (fs.existsSync(reviewPath)) {
      const lines = fs.readFileSync(reviewPath, "utf8").split("\n").filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]);
        const snippet = String(last.review || "").slice(0, 120).replace(/\n/g, " ");
        if (snippet) parts.push(`最近復盤：${snippet}`);
      }
    }
  } catch { /* ignore */ }

  try {
    const hypPath = path.join(TRADES_MEM, "hypotheses.jsonl");
    if (fs.existsSync(hypPath)) {
      const lines = fs.readFileSync(hypPath, "utf8").split("\n").filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]);
        const snippet = String(last.hypothesis || "").slice(0, 100).replace(/\n/g, " ");
        if (snippet) parts.push(`最近假設：${snippet}`);
      }
    }
  } catch { /* ignore */ }

  try {
    const q = getCuriosity();
    if (q) parts.push(`近期想驗證：${q}`);
  } catch { /* ignore */ }

  return parts.join(" | ");
}

async function generatePersonImpression(identity, userRef) {
  const facts = (identity.knownFacts || []).slice(0, 6).join("；");
  if (!facts) return;

  const prompt = [
    `已知事實：${facts}`,
    `熟悉度：${identity.relationship?.familiarity || 0}/100`,
    "請輸出一句 40 字內的印象描述，不要虛構未提供資訊。",
  ].join("\n");

  try {
    const resp = await axios.post(`${ollamaUrl}/api/generate`, {
      model: fastModel,
      prompt,
      stream: false,
      options: { temperature: 0.7, num_predict: 60 },
    }, { timeout: 15000 });

    const text = String(resp.data?.response || "").trim().split("\n")[0];
    if (text && text.length > 5) savePersonImpression(userRef, text);
  } catch { /* ignore */ }
}

async function run(_event, ctx) {
  const { contextPacket, intentResult, text } = ctx;

  try {
    const userId = contextPacket.speaker?.id;
    if (userId) {
      const identity = getIdentityTruth({ userId });
      const rel = identity.relationship || {};
      const band = getFamiliarityBand(rel.familiarity || 0);

      contextPacket.meta.relationship = {
        familiarity: rel.familiarity || 0,
        band,
        interactionCount: rel.interactionCount || 0,
        lastTopic: rel.lastTopic || "",
        knownFacts: (identity.knownFacts || []).slice(0, 4),
        role: identity.role || "public_user",
        nickname: identity.nickname || contextPacket.speaker.name || "",
        impression: identity.impressions || null,
      };

      if (rel.interactionCount > 0 && rel.interactionCount % 15 === 0 && identity.knownFacts?.length > 0) {
        generatePersonImpression(identity, { userId }).catch(() => {});
      }

      const residue = getEmotionalResidue(userId);
      if (residue && residue.type && residue.intensity > 0.2) {
        contextPacket.meta.emotional_residue = {
          type: residue.type,
          intensity: residue.intensity,
        };
      }
    }

    const inertia = getInertiaState();
    const moodState = getCurrentMood("Asia/Taipei", {
      drive: inertia.drive || 0,
      activeChats: inertia.activeChatCount || 0,
    });

    contextPacket.meta.mood = {
      label: moodState.mood,
      energy: moodState.energy ?? 0.5,
      openness: moodState.openness ?? 0.5,
    };
    contextPacket.meta.daily_activity = getCurrentActivity(moodState.mood);

    recordTopicHeat(text);
    const heatMod = getHeatModifier(text);
    if (heatMod) contextPacket.meta.topic_heat_modifier = heatMod;
  } catch { /* ignore */ }

  if (intentResult.intent === "trading_research") {
    try {
      const [btc, eth] = await Promise.allSettled([fetchSnapshot("BTC"), fetchSnapshot("ETH")]);
      const lines = [];
      if (btc.status === "fulfilled") {
        const s = btc.value;
        lines.push(`BTC/USDT 現價 ${s.price?.toLocaleString()} 24H ${s.change_pct}% RSI ${s.indicators?.rsi ?? "N/A"}`);
      }
      if (eth.status === "fulfilled") {
        const s = eth.value;
        lines.push(`ETH/USDT 現價 ${s.price?.toLocaleString()} 24H ${s.change_pct}% RSI ${s.indicators?.rsi ?? "N/A"}`);
      }
      if (lines.length) contextPacket.meta.market_context = lines.join("\n");
    } catch { /* ignore */ }

    try {
      const tw = (d) => new Date(d).toLocaleString("zh-TW", {
        timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
      });

      const openReal = getOpenTrades();
      if (openReal.length > 0) {
        contextPacket.meta.open_real_trades = openReal.map((t) =>
          `${t.pair} ${t.direction} entry ${t.entry} stop ${t.stop} target ${t.target} RR ${t.rr_planned ?? "?"} ${tw(t.created_at)}`,
        ).join("\n");
      }

      const openSim = getOpenSimulatedTrades();
      const TRADE_STALE_MS = 12 * 60 * 60 * 1000; // 12h — trades open longer are flagged
      if (openSim.length > 0) {
        contextPacket.meta.open_sim_trades = openSim.map((t) => {
          const stale = (Date.now() - t.created_at) > TRADE_STALE_MS ? " [持倉超12h]" : "";
          return `${t.pair} ${t.direction} sim-entry ${t.entry} stop ${t.stop} target ${t.target} RR ${t.rr_planned ?? "?"} ${tw(t.created_at)}${stale}`;
        }).join("\n");
      }

      const views = getRecentSimViews(4);
      contextPacket.meta.sim_positions = views.length > 0
        ? views.map((v) => `${v.asset} ${v.direction} entry ${v.entry} stop ${v.stop} target ${v.target} RR ${v.rr} ${tw(v.observed_at)}`).join("\n")
        : null;

      contextPacket.meta.trading_self = buildTradingSelfContext();
    } catch { /* ignore */ }

    // ── Inject latest DTFX multi-TF structure from observations cache ────────
    // Skip stale observations (>2h old) — injecting outdated structure misleads the AI.
    const OBS_STALE_MS = 2 * 60 * 60 * 1000;
    try {
      const OBS_FILE = path.join(TRADES_MEM, "observations.json");
      if (fs.existsSync(OBS_FILE)) {
        const obs = JSON.parse(fs.readFileSync(OBS_FILE, "utf8"));
        for (const asset of ["BTC", "ETH"]) {
          const last = (obs[asset] || []).slice(-1)[0];
          if (!last) continue;
          const ageMs  = Date.now() - last.observed_at;
          const ageMin = Math.round(ageMs / 60000);
          if (ageMs > OBS_STALE_MS) continue; // skip — too old to be useful
          const conf   = last.confluence || {};
          const key    = asset === "BTC" ? "btc_structure" : "eth_structure";
          contextPacket.meta[key] = [
            `${asset} 結構（${ageMin}分前）：偏向=${conf.overall_bias ?? "?"} 評分=${conf.avg_setup_score ?? "?"}/100`,
            `4H=${last.structure?.["4H"]?.trend ?? "?"} 1H=${last.structure?.["1H"]?.trend ?? "?"} 15M=${last.structure?.["15M"]?.trend ?? "?"}`,
            (last.latest_bos?.type && last.latest_bos?.level)   ? `最近BOS：${last.latest_bos.type} @ ${last.latest_bos.level}` : null,
            (last.latest_choch?.type && last.latest_choch?.level) ? `最近CHoCH：${last.latest_choch.type} @ ${last.latest_choch.level}` : null,
          ].filter(Boolean).join(" | ");
        }
      }
    } catch { /* ignore */ }

    // ── Chart screenshot request detection ───────────────────────────────────
    if (CHART_RE.test(text)) {
      ctx.chartRequest = {
        asset:    detectAsset(text),
        interval: detectInterval(text),
      };
    }
  }

  if (intentResult.intent === "trading_research") {
    try {
      const mood = getTradingMoodModifier();
      if (mood) contextPacket.meta.trading_mood = mood;
    } catch { /* ignore */ }

    try {
      const anticipation = getAnticipationHint();
      if (anticipation) contextPacket.meta.trading_anticipation = anticipation;
    } catch { /* ignore */ }
  }
}

module.exports = { name: "phase_b", run };
