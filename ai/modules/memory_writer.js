"use strict";
// Module 5 (Phase 2): memory_writer
// Decides what from each completed turn is worth storing in long-term memory.
// Wraps existing memory_event_detector + episodic_store.
//
// Design principles:
//   · Only runs after the AI reply is finalized (end of pipeline)
//   · Public comments and routing_level 0 turns are never stored
//   · Group context: personal-only event types are silently dropped
//   · Fire-and-forget: awaited internally but errors never propagate to caller
//   · Cross-platform user key via global_identity_map (same key as memory_selector)

const { detectMemoryEvent } = require("../memory_event_detector");
const { storeEpisode }      = require("../episodic_store");
const { getOrCreateGlobalUserKey } = require("../global_identity_map");

// Event types that must NOT be stored from group context
const GROUP_BLOCKED_TYPES = new Set([
  "PERSONAL_HISTORY",
  "LIFE_STORY",
  "EMOTIONAL_EVENT",
  "RELATIONSHIP_EVENT",
]);

/**
 * Attempt to extract and store episodic memory for this turn.
 * Fire-and-forget — caller should not await, or can await safely (never throws).
 *
 * @param {object} contextPacket  - from context_builder
 * @param {object} intentResult   - from intent_parser
 * @param {string} finalReply     - the AI's final reply text (used as light context)
 */
async function maybeWriteMemory(contextPacket, intentResult, finalReply) {
  try {
    const { scene, current_message } = contextPacket;
    const userText = current_message.text;

    // Never store public comment turns
    if (scene === "public_comment") return;
    // Routing level 0 = trivial social reply — no personal content to store
    if (intentResult.routing_level === 0) return;
    // Skip if text too short for meaningful episodic content
    if (!userText || userText.length < 20) return;

    // Resolve cross-platform user key
    const globalUserKey = resolveGlobalKey(contextPacket);
    if (!globalUserKey) return;

    // Build a short context string from recent conversation (helps detector accuracy)
    const recentContext = buildRecentContext(contextPacket, finalReply);

    // Run LLM-based event detector
    const detected = await detectMemoryEvent(userText, recentContext);
    if (!detected) return;

    // In group context, block personal-only event types
    if (scene === "group" && GROUP_BLOCKED_TYPES.has(detected.event_type)) return;

    await storeEpisode(globalUserKey, {
      event_type:    detected.event_type,
      summary:       detected.summary,
      importance:    detected.importance,
      emotional_tag: detected.emotional_tag || null,
      embedding:     null,   // embedding is computed lazily by memory_retriever if needed
    });
  } catch {
    // Intentionally silent — memory write failure must never break the main reply
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveGlobalKey(contextPacket) {
  const { speaker, platform, meta } = contextPacket;
  try {
    return getOrCreateGlobalUserKey({
      platform: platform || meta.connector || "unknown",
      userId:   speaker.id,
      username: speaker.name,
      channel:  meta.channel,
    });
  } catch {
    return null;
  }
}

function buildRecentContext(contextPacket, finalReply) {
  const lines = [];
  const recent = contextPacket.recent_messages || [];
  // Include last 3 turns for detector context
  for (const m of recent.slice(-3)) {
    const who = m.role === "bot" ? "AI" : (m.speaker_name || "User");
    lines.push(`${who}: ${m.text}`);
  }
  if (finalReply) lines.push(`AI: ${String(finalReply).slice(0, 200)}`);
  return lines.join("\n");
}

module.exports = { maybeWriteMemory };
