/**
 * episodic_store.js
 *
 * JSONL-based per-user episodic memory store.
 * Stored at: memory/episodes/{sanitized_globalUserKey}.jsonl
 *
 * Each line is one episode:
 *   { id, user_id, event_type, summary, importance, embedding, created_at }
 *
 * Includes:
 * - Deduplication via Jaccard similarity on summary text
 * - Tiered decay: importance < 0.5 → 4 days, 0.5–0.7 → 14 days, ≥ 0.7 → permanent
 * - Hard cap: MAX_EPISODES_PER_USER (keep highest importance)
 */

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const EPISODES_DIR = path.join(__dirname, "../memory/episodes");
const MAX_EPISODES_PER_USER = 200;
const DEDUP_JACCARD_THRESHOLD = 0.65; // skip if too similar to existing summary

// Tiered decay by importance:
// importance < 0.5  → short-term: 4 days  (daily events, casual shares, recent activities)
// importance 0.5–0.7 → mid-term: 30 days  (preference, mild personal info)
// importance ≥ 0.7  → permanent (life stories, core user facts — no decay)
const DECAY_TIERS = [
  { maxImportance: 0.5,  maxAgeMs: 4  * 24 * 60 * 60 * 1000 },
  { maxImportance: 0.7,  maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
];

function ensureDir() {
  fs.mkdirSync(EPISODES_DIR, { recursive: true });
}

function safeKey(globalUserKey) {
  return String(globalUserKey || "unknown").replace(/[^a-zA-Z0-9_\-]/g, "_");
}

function getEpisodesPath(globalUserKey) {
  ensureDir();
  return path.join(EPISODES_DIR, `${safeKey(globalUserKey)}.jsonl`);
}

function loadEpisodes(globalUserKey) {
  const fpath = getEpisodesPath(globalUserKey);
  if (!fs.existsSync(fpath)) return [];
  try {
    return fs
      .readFileSync(fpath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((ep) => ep && ep.summary);
  } catch {
    return [];
  }
}

function saveEpisodes(globalUserKey, episodes) {
  const fpath = getEpisodesPath(globalUserKey);
  fs.writeFileSync(
    fpath,
    episodes.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
}

// Simple Jaccard similarity on word sets — fast, no LLM needed
function jaccardSimilarity(a, b) {
  const tokenize = (s) => new Set(String(s || "").toLowerCase().split(/[\s,.\-_]+/).filter((w) => w.length > 1));
  const setA = tokenize(a);
  const setB = tokenize(b);
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function applyDecay(episodes) {
  const now = Date.now();
  return episodes.filter((ep) => {
    const importance = ep.importance || 0;
    const age = now - (ep.created_at || 0);
    // importance ≥ 0.7 → permanent, never decayed
    if (importance >= 0.7) return true;
    // Check tiered decay thresholds
    for (const tier of DECAY_TIERS) {
      if (importance < tier.maxImportance) {
        return age <= tier.maxAgeMs;
      }
    }
    return true;
  });
}

/**
 * Store a new episodic memory.
 * Returns the stored episode object, or null if skipped (duplicate/invalid).
 *
 * @param {string} globalUserKey
 * @param {{ event_type: string, summary: string, importance: number, embedding: number[]|null }} episode
 */
function storeEpisode(globalUserKey, { event_type, summary, importance, embedding }) {
  if (!globalUserKey || !summary) return null;

  const episodes = loadEpisodes(globalUserKey);

  // Deduplication: skip if too similar to an existing summary
  const isDuplicate = episodes.some(
    (ep) => jaccardSimilarity(ep.summary, summary) >= DEDUP_JACCARD_THRESHOLD,
  );
  if (isDuplicate) return null;

  const episode = {
    id: randomUUID(),
    user_id: globalUserKey,
    event_type: String(event_type || "GENERAL"),
    summary: String(summary),
    importance: Number(importance || 0.7),
    embedding: embedding || null,
    created_at: Date.now(),
  };

  // Decay stale low-importance entries
  const cleaned = applyDecay(episodes);
  cleaned.push(episode);

  // Cap total, keeping highest importance first
  const trimmed = cleaned
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, MAX_EPISODES_PER_USER);

  saveEpisodes(globalUserKey, trimmed);
  return episode;
}

/**
 * Retrieve all stored episodes for a user.
 * Used by the retriever for similarity search.
 */
function getEpisodes(globalUserKey) {
  return loadEpisodes(globalUserKey);
}

/**
 * Return a count of stored episodes for a user (for telemetry).
 */
function getEpisodeCount(globalUserKey) {
  return loadEpisodes(globalUserKey).length;
}

/**
 * Consolidate episodes for a user:
 * - Apply decay to remove expired entries
 * - Merge episodes within same event_type that are similar (Jaccard ≥ 0.4)
 * - Keep highest-importance episode from each merged cluster
 * Returns { before, after, removed, merged }
 */
function consolidateEpisodes(globalUserKey) {
  const episodes = loadEpisodes(globalUserKey);
  if (episodes.length < 5) return { before: episodes.length, after: episodes.length, removed: 0, merged: 0 };

  const afterDecay = applyDecay(episodes);

  // Group by event_type
  const groups = {};
  for (const ep of afterDecay) {
    const key = ep.event_type || "GENERAL";
    if (!groups[key]) groups[key] = [];
    groups[key].push(ep);
  }

  const kept = [];
  let mergedCount = 0;

  for (const group of Object.values(groups)) {
    const used = new Set();
    for (let i = 0; i < group.length; i++) {
      if (used.has(i)) continue;
      const cluster = [group[i]];
      used.add(i);
      for (let j = i + 1; j < group.length; j++) {
        if (used.has(j)) continue;
        if (jaccardSimilarity(group[i].summary, group[j].summary) >= 0.4) {
          cluster.push(group[j]);
          used.add(j);
        }
      }
      if (cluster.length === 1) {
        kept.push(cluster[0]);
      } else {
        // Keep highest-importance entry, discard the rest
        const best = cluster.reduce((a, b) => (a.importance || 0) >= (b.importance || 0) ? a : b);
        kept.push(best);
        mergedCount += cluster.length - 1;
      }
    }
  }

  const trimmed = kept
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, MAX_EPISODES_PER_USER);

  saveEpisodes(globalUserKey, trimmed);
  return {
    before: episodes.length,
    after: trimmed.length,
    removed: episodes.length - trimmed.length,
    merged: mergedCount,
  };
}

module.exports = { storeEpisode, getEpisodes, getEpisodeCount, consolidateEpisodes };
