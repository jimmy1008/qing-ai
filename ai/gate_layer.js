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
 *
 * 冷卻：同一群組 name/topic 觸發後 3 分鐘內不重複觸發。
 */

const { getFamiliarityLevel } = require("./familiarity_engine");
const { getTopTopics }        = require("./modules/topic_interest");

// ── Config ────────────────────────────────────────────────────────────────────
const COOLDOWN_MS         = 3 * 60 * 1000;   // 3 min group cooldown
const MIN_TOPIC_SCORE     = 3;                // topic_interest score threshold
const ABSENCE_DAYS        = 2;               // days without interaction → proactive eligible
const ABSENCE_MS          = ABSENCE_DAYS * 24 * 60 * 60 * 1000;

// ── Name / self-topic regex ───────────────────────────────────────────────────
const SELF_NAME_RE = /(?<![天])晴(?![天朗空雨])|(?:問|找|叫|說到|提到|問問)晴(?!天)/;

// ── Per-group cooldown store ──────────────────────────────────────────────────
const _cooldowns = new Map();

function _onCooldown(groupId, type) {
  const key  = `${groupId}:${type}`;
  const last = _cooldowns.get(key) || 0;
  return Date.now() - last < COOLDOWN_MS;
}

function _setCooldown(groupId, type) {
  _cooldowns.set(`${groupId}:${type}`, Date.now());
}

// ── Topic match check ─────────────────────────────────────────────────────────
function _topicMatch(text) {
  try {
    const topics = getTopTopics(3);  // top 3 topics by score
    if (!topics || topics.length === 0) return false;

    const lowerText = text.toLowerCase();
    for (const t of topics) {
      if (t.score < MIN_TOPIC_SCORE) continue;
      const info = t.info;
      const keywords = info?.keywords || [];
      if (keywords.some(kw => lowerText.includes(kw.toLowerCase()))) {
        return true;
      }
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

  // L2: check trigger conditions ────────────────────────────────────────────

  // 1. Name mentioned
  if (SELF_NAME_RE.test(text)) {
    if (_onCooldown(groupId, "name")) {
      return { pass: false, reason: "name_cooldown" };
    }
    _setCooldown(groupId, "name");
    return { pass: true, reason: "name_mentioned" };
  }

  // 2. Topic match + familiarity requirement (>= 30 to avoid low-familiar spam)
  if (familiarity >= 30 && _topicMatch(text)) {
    if (_onCooldown(groupId, "topic")) {
      return { pass: false, reason: "topic_cooldown" };
    }
    _setCooldown(groupId, "topic");
    return { pass: true, reason: "topic_match" };
  }

  // 3. Long absence (>= 2 days) + non-trivial message
  if (_longAbsent(lastInteractionAt) && text.length >= 4) {
    if (_onCooldown(groupId, "absence")) {
      return { pass: false, reason: "absence_cooldown" };
    }
    _setCooldown(groupId, "absence");
    return { pass: true, reason: "long_absence_rejoin" };
  }

  return { pass: false, reason: "L2_no_trigger" };
}

/**
 * Multi-question filter: given detected questions, pick how many to respond to
 * based on familiarity level.
 * Returns sliced array.
 */
function filterQuestions(questions = [], familiarity = 0, role = "public_user") {
  const level = getFamiliarityLevel(familiarity, role);
  if (level === "L1")                    return questions;           // all
  if (familiarity >= 50)                 return questions.slice(0, 3); // L2 high
  if (familiarity >= 20)                 return questions.slice(0, 1); // L2 low — pick 1
  return questions.slice(0, 1);                                      // L3
}

module.exports = { shouldDispatch, filterQuestions };
