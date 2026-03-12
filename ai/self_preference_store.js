/**
 * self_preference_store.js
 *
 * Stores 晴晴's own discovered preferences as she expresses them in conversation.
 * Each time she says something like "我喜歡X" or "X好有趣" in a reply,
 * it gets detected and saved here — building up a real preference profile over time.
 *
 * Storage: memory/self_preferences.json
 * Format: { likes: [...], dislikes: [...] }
 * Cap: 40 total entries (oldest trimmed when full)
 */

const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "../memory/self_preferences.json");
const MAX_ENTRIES = 40;

function load() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { likes: [], dislikes: [] };
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return { likes: [], dislikes: [] };
  }
}

function save(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Add a discovered preference.
 * @param {"like"|"dislike"} type
 * @param {string} item - what she likes/dislikes
 * @param {string} context - brief note on the context (optional)
 */
function addPreference(type, item, context = "") {
  if (!item || item.length < 2) return;
  const store = load();
  const list = type === "dislike" ? store.dislikes : store.likes;

  // Deduplicate: skip if very similar item already exists
  const isDupe = list.some((e) => {
    const a = String(e.item || "").toLowerCase();
    const b = item.toLowerCase();
    return a === b || a.includes(b) || b.includes(a);
  });
  if (isDupe) return;

  list.push({ item, context, discovered_at: Date.now() });

  // Trim oldest if over cap (keep total across both lists ≤ MAX_ENTRIES)
  const total = store.likes.length + store.dislikes.length;
  if (total > MAX_ENTRIES) {
    // Remove oldest from whichever list is bigger
    if (store.likes.length >= store.dislikes.length) {
      store.likes.sort((a, b) => a.discovered_at - b.discovered_at).shift();
    } else {
      store.dislikes.sort((a, b) => a.discovered_at - b.discovered_at).shift();
    }
  }

  save(store);
}

/**
 * Get all stored preferences for system prompt injection.
 * Returns { likes: string[], dislikes: string[] }
 */
function getPreferences() {
  const store = load();
  return {
    likes: (store.likes || []).map((e) => e.item),
    dislikes: (store.dislikes || []).map((e) => e.item),
  };
}

/**
 * Build the [PersonalStances] prompt block from stored preferences.
 * Returns empty string if nothing stored yet.
 */
function buildSelfPreferenceBlock() {
  const { likes, dislikes } = getPreferences();
  if (!likes.length && !dislikes.length) return "";

  const lines = ["[PersonalStances — discovered through conversation, genuine]"];
  if (likes.length) {
    lines.push("Things you genuinely like (reference naturally when relevant):");
    likes.forEach((item) => lines.push(`- ${item}`));
  }
  if (dislikes.length) {
    lines.push("Things you genuinely dislike or find boring:");
    dislikes.forEach((item) => lines.push(`- ${item}`));
  }
  lines.push("Note: Only reference these when the topic naturally comes up. Do not list them all at once.");
  return lines.join("\n");
}

module.exports = { addPreference, getPreferences, buildSelfPreferenceBlock };
