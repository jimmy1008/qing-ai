"use strict";
// Module 4 (Phase 2): memory_selector
// Retrieves relevant memories for the current turn with scene isolation.
// Wraps existing memory_retriever + episodic_store; adds scene-based filtering.
//
// Design principles:
//   · Private scene  → full access to user's personal memories
//   · Group scene    → only memories tagged as group-safe (no highly personal data)
//   · Public comment → no personal memory injection (noise risk too high)
//   · User A's memories NEVER appear in User B's context (key-isolated)
//
// selectedMemory schema:
// {
//   memory_id: string,
//   type: "episodic"|"working",
//   content: string,       // the text to inject into the prompt
//   reason: string,        // why this memory was selected
//   confidence: number,    // 0–1 similarity score
//   scene_tag: string,     // original scene the memory was stored in
// }

const { retrieveMemories }      = require("../memory_retriever");
const { getOrCreateGlobalUserKey } = require("../global_identity_map");

// Don't retrieve memories for trivial turns
const MIN_QUERY_LENGTH = 10;
// Don't inject if confidence is below this threshold
const MIN_CONFIDENCE   = 0.20;
// Max memories to inject per turn
const MAX_MEMORIES     = 3;

// Private-only event types that should NOT appear in group context
const PRIVATE_ONLY_TYPES = new Set([
  "PERSONAL_HISTORY",
  "LIFE_STORY",
  "EMOTIONAL_EVENT",
  "RELATIONSHIP_EVENT",
]);

/**
 * Selects relevant memories for the current turn.
 * @param {object} contextPacket
 * @param {object} intentResult
 * @returns {Promise<Array>}  selectedMemories
 */
async function selectMemories(contextPacket, intentResult) {
  const { scene, speaker, current_message } = contextPacket;
  const query = current_message.text;

  // Public comments: no personal memory injection
  if (scene === "public_comment") return [];
  // Too short to have meaningful retrieval
  if (!query || query.length < MIN_QUERY_LENGTH) return [];
  // Low-difficulty turns (routing_level 0) skip memory — not worth the latency
  if (intentResult.routing_level === 0) return [];
  // Only retrieve if intent suggests memory could help
  if (!intentResult.needs_memory && intentResult.routing_level < 2) return [];

  // Resolve cross-platform user key
  const globalUserKey = resolveGlobalKey(contextPacket);
  if (!globalUserKey) return [];

  try {
    const raw = await retrieveMemories(globalUserKey, query);
    if (!raw || raw.length === 0) return [];

    return raw
      .filter(m => meetsConfidenceThreshold(m, scene))
      .filter(m => passesSceneFilter(m, scene))
      .slice(0, MAX_MEMORIES)
      .map((m, i) => ({
        memory_id:  `${globalUserKey}_${i}`,
        type:       "episodic",
        content:    m.summary,
        reason:     `${m.event_type} — similarity ${m.similarity}`,
        confidence: m.similarity,
        scene_tag:  m.scene || "unknown",
      }));
  } catch {
    return [];
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

function meetsConfidenceThreshold(memory, scene) {
  const threshold = scene === "private" ? MIN_CONFIDENCE : MIN_CONFIDENCE + 0.10;
  return (memory.similarity || 0) >= threshold;
}

function passesSceneFilter(memory, scene) {
  // In group context, block memories that are too personal
  if (scene === "group" && PRIVATE_ONLY_TYPES.has(memory.event_type)) {
    return false;
  }
  return true;
}

module.exports = { selectMemories };
