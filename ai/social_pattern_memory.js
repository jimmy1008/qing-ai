"use strict";
/**
 * social_pattern_memory.js
 *
 * 儲存晴從群組觀察到的溝通風格模式。
 *
 * 觸發：每收到 SAMPLE_EVERY 則新群組訊息後，分析並滾動更新。
 * 儲存：memory/social_patterns/{groupId}.json
 * 設計原則：只存風格特徵（語氣/節奏/幽默感），不存任何原始句子或個人觀點。
 */

const fs   = require("fs");
const path = require("path");
const { analyzeMessages } = require("./modules/conversation_observer");

const PATTERNS_DIR  = path.join(__dirname, "../memory/social_patterns");
const MAX_OBS       = 12;   // keep last N observations for rolling average
const SAMPLE_EVERY  = 8;    // analyze after this many new messages

// In-memory pending counters: groupId → pendingCount
const _pending = new Map();

// ── IO ────────────────────────────────────────────────────────────────────────

function _ensureDir() {
  if (!fs.existsSync(PATTERNS_DIR)) fs.mkdirSync(PATTERNS_DIR, { recursive: true });
}

function _loadPattern(groupId) {
  _ensureDir();
  const fp = path.join(PATTERNS_DIR, `${groupId}.json`);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {}
  return { groupId, observations: [], summary: null, lastUpdated: null };
}

function _savePattern(groupId, data) {
  _ensureDir();
  fs.writeFileSync(
    path.join(PATTERNS_DIR, `${groupId}.json`),
    JSON.stringify(data, null, 2), "utf-8"
  );
}

// ── Rolling summary ───────────────────────────────────────────────────────────

/**
 * Compute a weighted summary from recent observations.
 * More recent observations have higher weight.
 */
function _computeSummary(observations) {
  if (!observations || observations.length === 0) return null;

  // Count frequencies, weighted by recency
  const weights = { tone: {}, humor: {}, energy: {}, lengthPref: {}, emojiUse: {} };

  observations.forEach((obs, i) => {
    const w = i + 1; // more recent = higher index = higher weight
    for (const key of ["tone", "humor", "energy", "lengthPref", "emojiUse"]) {
      const val = obs[key];
      if (!val) continue;
      weights[key][val] = (weights[key][val] || 0) + w;
    }
  });

  function topKey(obj) {
    return Object.entries(obj).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  return {
    tone:       topKey(weights.tone),
    humor:      topKey(weights.humor),
    energy:     topKey(weights.energy),
    lengthPref: topKey(weights.lengthPref),
    emojiUse:   topKey(weights.emojiUse),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Called after every new group message.
 * Buffers until SAMPLE_EVERY messages, then samples.
 *
 * @param {string} groupId   — prefixed group key, e.g. "tg_-100xxxx" or "dc_channelId"
 * @param {Array}  messages  — current recentMessages array from registry
 */
function maybeSamplePattern(groupId, messages) {
  if (!groupId || !Array.isArray(messages) || messages.length === 0) return;

  const count = (_pending.get(groupId) || 0) + 1;
  _pending.set(groupId, count);

  if (count < SAMPLE_EVERY) return;
  _pending.set(groupId, 0);

  // Run analysis synchronously (heuristic, fast)
  try {
    const obs = analyzeMessages(messages);
    if (!obs) return;

    const pattern = _loadPattern(groupId);
    pattern.observations = [...(pattern.observations || []).slice(-(MAX_OBS - 1)), obs];
    pattern.summary      = _computeSummary(pattern.observations);
    pattern.lastUpdated  = Date.now();
    _savePattern(groupId, pattern);
  } catch (e) {
    // Non-critical, fail silently
  }
}

/**
 * Get a short natural-language hint for persona_generator.
 * Returns null if no pattern exists or pattern is too weak.
 *
 * @param {string} groupId
 * @returns {string|null}
 */
function getSocialPatternHint(groupId) {
  if (!groupId) return null;
  try {
    const pattern = _loadPattern(groupId);
    const s = pattern?.summary;
    if (!s || !s.tone) return null;

    const parts = [];

    // Tone
    if (s.tone === "playful")    parts.push("群組氣氛輕鬆愛玩");
    else if (s.tone === "heated")   parts.push("群組討論偏熱烈，大家喜歡辯論");
    else if (s.tone === "thoughtful") parts.push("群組氣氛比較認真，大家喜歡深入討論");
    else                            parts.push("群組氣氛輕鬆隨意");

    // Humor
    if (s.humor === "heavy")  parts.push("很常開玩笑");
    else if (s.humor === "light") parts.push("偶爾有笑點");

    // Energy / length
    if (s.energy === "fast" && s.lengthPref === "short") parts.push("訊息偏短、節奏快");
    else if (s.energy === "slow" && s.lengthPref === "long") parts.push("習慣發長訊息");

    // Emoji
    if (s.emojiUse === "heavy") parts.push("喜歡用 emoji");
    else if (s.emojiUse === "none") parts.push("幾乎不用 emoji");

    if (parts.length === 0) return null;
    return `[群組溝通風格]\n${parts.join("，")}。\n（可自然融入這個節奏，不需要刻意模仿，僅作為氣氛參考）`;
  } catch {
    return null;
  }
}

module.exports = { maybeSamplePattern, getSocialPatternHint };
