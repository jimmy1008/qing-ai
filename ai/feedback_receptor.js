"use strict";
/**
 * feedback_receptor.js
 *
 * Translates user reaction signals into memory updates.
 *
 * Positive reactions (👍 ❤️ 🔥 💯 😍 🎉 🥰) →
 *   · Boost episodic memory importance if a matching episode exists
 *   · Add positive preference evidence (topic reinforcement)
 *
 * Negative reactions (👎) →
 *   · Reduce episodic memory importance
 *   · Add avoid preference evidence
 *
 * Does NOT touch working memory — reaction feedback is long-term signal only.
 */

const { getEpisodes, saveEpisodes } = require("./episodic_store");
const { getOrCreateGlobalUserKey }  = require("./global_identity_map");
const { resolveStoredGlobalKey }    = require("./global_identity_map");

// Positive emoji sets
const POSITIVE_EMOJI = new Set(["👍", "❤️", "🔥", "💯", "😍", "🎉", "🥰", "😂", "🤩", "✅"]);
const NEGATIVE_EMOJI = new Set(["👎", "😢", "😡", "🤡", "💀"]);

/**
 * Classify a Telegram reaction emoji.
 * @returns "positive" | "negative" | "neutral"
 */
function classifyReaction(emoji) {
  if (!emoji) return "neutral";
  if (POSITIVE_EMOJI.has(emoji)) return "positive";
  if (NEGATIVE_EMOJI.has(emoji)) return "negative";
  return "neutral";
}

/**
 * Process a reaction event.
 *
 * @param {object} opts
 * @param {string} opts.platform        — "telegram"
 * @param {string} opts.userId          — reactor's userId (string)
 * @param {string} opts.replyText       — the AI reply that was reacted to
 * @param {string} opts.userText        — the user message that triggered the reply (optional)
 * @param {string} opts.emoji           — the reaction emoji
 * @param {string} [opts.globalKey]     — pre-resolved globalKey (optional)
 */
function processReaction({ platform = "telegram", userId, replyText, userText, emoji, globalKey }) {
  const signal = classifyReaction(emoji);
  if (signal === "neutral") return; // ignore neutral emoji

  // Resolve global key
  const gKey = globalKey || resolveStoredGlobalKey(String(userId));
  if (!gKey || gKey === "global_unknown") return;

  try {
    _updateEpisodicMemory(gKey, replyText, signal);
  } catch (e) {
    console.warn("[feedback_receptor] episodic update failed:", e.message);
  }

  console.log(`[feedback] ${emoji} (${signal}) on reply by ${gKey}: "${String(replyText).slice(0, 40)}..."`);
}

/**
 * Find the most recent episodic memory whose summary overlaps with replyText,
 * then boost or reduce its importance.
 */
function _updateEpisodicMemory(globalKey, replyText, signal) {
  const episodes = getEpisodes(globalKey);
  if (!episodes || episodes.length === 0) return;

  const query  = String(replyText || "").toLowerCase().slice(0, 200);
  const words  = new Set(query.split(/[\s，。！？、,.!?]+/).filter(w => w.length > 1));

  // Score each episode by overlap with reply text
  let best = null;
  let bestScore = 0;

  for (const ep of episodes) {
    const summary = String(ep.summary || "").toLowerCase();
    let overlap = 0;
    for (const w of words) {
      if (summary.includes(w)) overlap++;
    }
    const score = words.size > 0 ? overlap / words.size : 0;
    if (score > bestScore) {
      bestScore = score;
      best = ep;
    }
  }

  // Only update if meaningful overlap found (>15% word match)
  if (!best || bestScore < 0.15) return;

  const delta = signal === "positive" ? 0.15 : -0.15;
  best.importance = Math.max(0.1, Math.min(1.0, (best.importance || 0.5) + delta));

  // If boosted to permanent tier, clear decay fields
  if (signal === "positive" && best.importance >= 0.7) {
    best.feedback_pinned = true; // prevent decay pruning
  }

  saveEpisodes(globalKey, episodes);
}

module.exports = { processReaction, classifyReaction };
