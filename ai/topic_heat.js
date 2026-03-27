"use strict";
/**
 * topic_heat.js
 *
 * 24-hour rolling topic frequency tracker.
 * Detects when a topic has been discussed "too many times" and injects
 * a fatigue signal into the persona context.
 *
 * Heat levels:
 *   0 = fresh (0–2 mentions)
 *   1 = warm  (3–5 mentions) — no injection
 *   2 = hot   (6–9 mentions) — mild fatigue injected
 *   3 = saturated (10+)     — explicit low-energy signal
 */

const fs   = require("fs");
const path = require("path");

const HEAT_FILE    = path.join(__dirname, "../memory/topic_heat.json");
const WINDOW_MS    = 24 * 60 * 60 * 1000; // 24 hours
const SAVE_DEBOUNCE_MS = 30 * 1000;

// In-memory state
let _heat = null;
let _dirty = false;
let _saveTimer = null;

// Topic keyword patterns → canonical key
const TOPIC_PATTERNS = [
  { key: "btc",      re: /btc|bitcoin|比特幣/i },
  { key: "eth",      re: /eth|ethereum|以太/i },
  { key: "trading",  re: /交易|做單|倉位|進場|出場|看多|看空|K線|k棒|order block|fvg|dtfx/i },
  { key: "market",   re: /市場|行情|大盤|漲|跌|回調|pump|dump/i },
  { key: "ai_topic", re: /ai|人工智能|機器人|語言模型|gpt|claude/i },
  { key: "work",     re: /工作|上班|公司|老闆|同事|職場/i },
  { key: "sleep",    re: /睡|失眠|醒|覺|熬夜/i },
  { key: "food",     re: /吃|食|餐|飯|飲|喝|料理|外送/i },
  { key: "identity", re: /你是誰|你是ai|你是真人|你有沒有感覺|你有意識嗎/i },
];

function load() {
  if (_heat) return _heat;
  try {
    _heat = JSON.parse(fs.readFileSync(HEAT_FILE, "utf8"));
  } catch {
    _heat = { topics: {}, window_start: Date.now() };
  }
  return _heat;
}

function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (!_dirty) return;
    try {
      fs.mkdirSync(path.dirname(HEAT_FILE), { recursive: true });
      fs.writeFileSync(HEAT_FILE, JSON.stringify(_heat, null, 2), "utf8");
      _dirty = false;
    } catch { /* ignore */ }
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Detect topic keys in a message text.
 * @param {string} text
 * @returns {string[]} matched topic keys
 */
function detectTopics(text = "") {
  return TOPIC_PATTERNS.filter(p => p.re.test(text)).map(p => p.key);
}

/**
 * Record a message and update heat counters.
 * Call this for every processed message.
 * @param {string} text
 */
function recordMessage(text) {
  const keys = detectTopics(text);
  if (keys.length === 0) return;
  const state = load();
  const now   = Date.now();

  // Prune entries older than window
  for (const [k, v] of Object.entries(state.topics)) {
    state.topics[k] = (v || []).filter(ts => now - ts < WINDOW_MS);
    if (state.topics[k].length === 0) delete state.topics[k];
  }

  for (const key of keys) {
    if (!state.topics[key]) state.topics[key] = [];
    state.topics[key].push(now);
  }

  _dirty = true;
  scheduleSave();
}

/**
 * Get heat level (0–3) for a specific topic key.
 */
function getHeatLevel(key) {
  const state = load();
  const now   = Date.now();
  const recent = (state.topics[key] || []).filter(ts => now - ts < WINDOW_MS);
  if (recent.length >= 10) return 3;
  if (recent.length >= 6)  return 2;
  if (recent.length >= 3)  return 1;
  return 0;
}

/**
 * Returns a fatigue/engagement modifier string to inject into context.
 * Returns null if no notable heat.
 * @param {string} text  — current message text
 * @returns {string|null}
 */
function getHeatModifier(text) {
  const keys = detectTopics(text);
  if (keys.length === 0) return null;

  const maxHeat = Math.max(...keys.map(getHeatLevel));
  if (maxHeat < 2) return null;

  if (maxHeat === 3) {
    return "（這個話題今天已經來回很多次了，你有點聊膩了，回應可以短一點、更隨意一點）";
  }
  // level 2
  return "（這個話題今天談了不少次，你不是沒興趣，只是有點重複感，語氣可以稍微懶一點）";
}

module.exports = { recordMessage, detectTopics, getHeatLevel, getHeatModifier };
