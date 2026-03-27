"use strict";
/**
 * gate_layer.js
 *
 * 決定一則訊息是否應該進入 pipeline。
 *
 * 等級定義（基於 familiarity score + role）：
 *   L1  developer/owner  → 所有訊息進 pipeline
 *   L2  familiar (20-74) → 條件觸發
 *   L3  stranger (0-19)  → @only
 *
 * 觸發條件（群聊 L2）：
 *   - 說到晴的名字
 *   - 話題跟她的 topic_interest 重疊（分數 > MIN_TOPIC_SCORE）
 *   - 回覆她說的話
 *   - 兩天以上沒互動 + 目前話題活躍
 *   - 話題延續：她剛說過話，別人在同話題繼續，她可以繼續參與
 *
 * 冷卻：同一群組各觸發類型獨立冷卻。
 */

const { getFamiliarityLevel } = require("./familiarity_engine");
const { getTopTopics }        = require("./modules/topic_interest");

// ── Config ────────────────────────────────────────────────────────────────────
const COOLDOWN_MS              = 3 * 60 * 1000;   // 一般觸發冷卻 3 min
const CONTINUATION_WINDOW_MS   = 8 * 60 * 1000;   // 晴說完後 8 min 內算話題延續窗口
const CONTINUATION_COOLDOWN_MS = 5 * 60 * 1000;   // 延續觸發自己的冷卻 5 min
const MIN_TOPIC_SCORE          = 3;
const ABSENCE_DAYS             = 2;
const ABSENCE_MS               = ABSENCE_DAYS * 24 * 60 * 60 * 1000;

// ── Name / self-topic regex ───────────────────────────────────────────────────
const SELF_NAME_RE = /(?<![天])晴(?![天朗空雨])|(?:問|找|叫|說到|提到|問問)晴(?!天)/;

// ── Per-group cooldown store ──────────────────────────────────────────────────
const _cooldowns = new Map();

function _onCooldown(groupId, type, ms = COOLDOWN_MS) {
  const key  = `${groupId}:${type}`;
  const last = _cooldowns.get(key) || 0;
  return Date.now() - last < ms;
}

function _setCooldown(groupId, type) {
  _cooldowns.set(`${groupId}:${type}`, Date.now());
}

// ── Topic continuation store ──────────────────────────────────────────────────
// Tracks when/what 晴 last said in each group, for continuation detection.
// { groupId → { timestamp, keywords: string[] } }
const _lastBotReply = new Map();

/**
 * Call this after 晴 sends a reply in a group.
 * Records the timestamp + keywords so continuation can be detected.
 */
function recordBotReply(groupId, replyText = "") {
  const keywords = _extractKeywords(replyText);
  _lastBotReply.set(String(groupId), {
    timestamp: Date.now(),
    keywords,
  });
}

// No keyword extraction needed — continuation uses time window only.
// Keyword matching had too many false negatives (positional bigrams miss
// the same word in different contexts). Time window is a cleaner proxy.
function _extractKeywords(_text) {
  return [];  // unused — kept for future use
}

// ── Continuation check ────────────────────────────────────────────────────────
// Uses time window only: if bot replied recently in this group, the next
// non-trivial message is treated as "still in the same conversation."
// Frequency is controlled by CONTINUATION_COOLDOWN_MS, not keyword matching.
function _isContinuation(groupId) {
  const last = _lastBotReply.get(String(groupId));
  if (!last) return false;
  return Date.now() - last.timestamp <= CONTINUATION_WINDOW_MS;
}

// ── Topic match check ─────────────────────────────────────────────────────────
function _topicMatch(text) {
  try {
    const topics = getTopTopics(3);
    if (!topics || topics.length === 0) return false;
    const lowerText = text.toLowerCase();
    for (const t of topics) {
      if (t.score < MIN_TOPIC_SCORE) continue;
      const keywords = t.info?.keywords || [];
      if (keywords.some(kw => lowerText.includes(kw.toLowerCase()))) return true;
    }
  } catch {}
  return false;
}

// ── Absence check ─────────────────────────────────────────────────────────────
function _longAbsent(lastInteractionAt) {
  if (!lastInteractionAt) return false;
  return Date.now() - lastInteractionAt > ABSENCE_MS;
}

/**
 * Main gate function.
 *
 * @param {object} opts
 *   .text              - message text
 *   .isPrivate         - boolean
 *   .isMention         - boolean (@ bot or replied to bot)
 *   .isCommand         - boolean
 *   .groupId           - string (for cooldown)
 *   .role              - "developer" | "public_user"
 *   .familiarity       - 0-100 score
 *   .lastInteractionAt - ms timestamp (from memory)
 *   .replyToBot        - boolean (user replied to bot's message)
 *
 * @returns { pass: boolean, reason: string }
 */
function shouldDispatch(opts = {}) {
  const {
    text = "",
    isPrivate = false,
    isMention = false,
    isCommand = false,
    groupId   = "unknown",
    role      = "public_user",
    familiarity = 0,
    lastInteractionAt = 0,
    replyToBot = false,
  } = opts;

  // Commands always pass
  if (isCommand) return { pass: true, reason: "command" };

  // Private chat always passes
  if (isPrivate) return { pass: true, reason: "private" };

  // L1: developer/owner → always pass
  const level = getFamiliarityLevel(familiarity, role);
  if (level === "L1") return { pass: true, reason: "L1_owner" };

  // ── Group chat from here ──────────────────────────────────────────────────

  // Direct @mention or reply-to-bot always passes (any level)
  if (isMention || replyToBot) return { pass: true, reason: "mention_or_reply" };

  // L3 stranger: only @mention passes (already handled above)
  if (level === "L3") return { pass: false, reason: "L3_no_mention" };

  // ── L2: check trigger conditions (in priority order) ─────────────────────

  // 1. Name mentioned
  if (SELF_NAME_RE.test(text)) {
    if (_onCooldown(groupId, "name")) return { pass: false, reason: "name_cooldown" };
    _setCooldown(groupId, "name");
    return { pass: true, reason: "name_mentioned" };
  }

  // 2. Topic continuation — she replied recently, conversation still ongoing
  //    Only L2 (familiarity >= 20), separate 5-min cooldown limits frequency
  if (familiarity >= 20 && text.length >= 4 && _isContinuation(groupId)) {
    if (_onCooldown(groupId, "continuation", CONTINUATION_COOLDOWN_MS)) {
      return { pass: false, reason: "continuation_cooldown" };
    }
    _setCooldown(groupId, "continuation");
    return { pass: true, reason: "topic_continuation" };
  }

  // 3. Topic match with interest map (familiarity >= 30)
  if (familiarity >= 30 && _topicMatch(text)) {
    if (_onCooldown(groupId, "topic")) return { pass: false, reason: "topic_cooldown" };
    _setCooldown(groupId, "topic");
    return { pass: true, reason: "topic_match" };
  }

  // 4. Long absence (>= 2 days) + non-trivial message
  if (_longAbsent(lastInteractionAt) && text.length >= 4) {
    if (_onCooldown(groupId, "absence")) return { pass: false, reason: "absence_cooldown" };
    _setCooldown(groupId, "absence");
    return { pass: true, reason: "long_absence_rejoin" };
  }

  return { pass: false, reason: "L2_no_trigger" };
}

/**
 * Multi-question filter: given detected questions, pick how many to respond to
 * based on familiarity level.
 */
function filterQuestions(questions = [], familiarity = 0, role = "public_user") {
  const level = getFamiliarityLevel(familiarity, role);
  if (level === "L1")        return questions;
  if (familiarity >= 50)     return questions.slice(0, 3);
  if (familiarity >= 20)     return questions.slice(0, 1);
  return questions.slice(0, 1);
}

module.exports = { shouldDispatch, filterQuestions, recordBotReply };
