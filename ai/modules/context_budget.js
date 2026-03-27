"use strict";
/**
 * context_budget.js
 *
 * Context Window Budget Manager for persona_generator.
 *
 * qwen3:8b default context: 8192 tokens.
 * System prompt actual size: ~2,900 tokens (HARD_LOCK ~1050 + CORE ~200 +
 *   STANCES ~300 + ROLE_BOUNDARY ~450 + FEW_SHOT ~225 + STYLE ~175 +
 *   dynamic blocks ~500). NOT 600 as previously estimated.
 * Reserved for output: ~400 tokens.
 * → User prompt budget: 8192 - 2900 - 400 = 4892 tokens ≈ 9784 chars.
 *   Set to 9500 for safety. Override with LLM_USER_PROMPT_BUDGET env var
 *   if using a larger context model (e.g. qwen3:8b with num_ctx=32768).
 *
 * Token estimation: 1 token ≈ 2 chars (conservative for mixed text).
 *
 * Priority tiers (highest → lowest):
 *   CRITICAL  — current message (always included, truncate if monster-length)
 *   HIGH      — recent conversation turns (trim oldest first)
 *   MEDIUM    — episodic memories (trim from end)
 *   LOW       — known facts, lastTopic, impression
 *   OPTIONAL  — emotional residue, daily activity, market/trading context
 */

const USER_PROMPT_CHAR_BUDGET = Number(process.env.LLM_USER_PROMPT_BUDGET) || 9500;
const CURRENT_MSG_MAX_CHARS   = 3000;  // hard cap on single user message
const RECENT_TURNS_MAX        = 8;     // max turns before budget check
const MEMORY_MAX              = 3;     // max episodic memories before budget check
const FACT_MAX                = 4;     // max known facts before budget check

/**
 * Estimate token count from text (character-based proxy).
 * CJK chars ≈ 1 token each; ASCII ≈ 0.25 token each.
 * Conservatively: 1 token per 2 chars of mixed text.
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 2);
}

function estimateChars(text) {
  return String(text || "").length;
}

/**
 * Budget-aware context block builder.
 *
 * Each block has:
 *   { priority: "critical"|"high"|"medium"|"low"|"optional", text: string }
 *
 * Returns the assembled prompt string that fits within budget.
 */
function applyBudget(blocks) {
  let remaining = USER_PROMPT_CHAR_BUDGET;
  const output  = [];

  // Process in priority order
  const order = ["critical", "high", "medium", "low", "optional"];
  const grouped = {};
  for (const p of order) grouped[p] = [];
  for (const b of blocks) {
    const p = b.priority || "optional";
    if (grouped[p]) grouped[p].push(b);
  }

  for (const priority of order) {
    for (const block of grouped[priority]) {
      const chars = estimateChars(block.text);
      if (priority === "critical") {
        // Always include; truncate if over hard cap
        const safe = block.text.slice(0, CURRENT_MSG_MAX_CHARS);
        output.push(safe);
        remaining -= estimateChars(safe);
      } else if (remaining > 0 && chars <= remaining) {
        output.push(block.text);
        remaining -= chars;
      } else if (remaining > 200 && priority === "high") {
        // Partial inclusion for high-priority: include as much as fits
        const partial = block.text.slice(0, Math.max(1, remaining - 50));
        if (partial.trim()) {
          output.push(partial);
          remaining = 0;
        }
      }
      // optional/low: skip if no budget left
    }
  }

  return output.join("\n");
}

/**
 * Trim recent turns to fit within a char budget slice.
 * Keeps the most recent turns.
 */
function trimRecentTurns(turns, budgetChars) {
  if (!turns || turns.length === 0) return [];
  // Start from most recent, accumulate until budget
  const result = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const len = estimateChars(turns[i].text) + 10; // +10 for "名字：" prefix
    if (used + len > budgetChars && result.length > 0) break;
    result.unshift(turns[i]);
    used += len;
  }
  return result;
}

module.exports = { estimateTokens, estimateChars, applyBudget, trimRecentTurns, USER_PROMPT_CHAR_BUDGET };
