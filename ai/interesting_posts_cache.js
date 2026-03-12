const fs = require("fs");
const path = require("path");

const CACHE_PATH = path.join(__dirname, "../telemetry/interesting_posts_cache.json");
const MAX_ENTRIES = 20;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCache(entries) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(entries, null, 2));
  } catch { /* ignore */ }
}

/**
 * Save a post the AI found interesting while browsing.
 * @param {{ url: string, text: string, authorUsername: string, emotion: string }} post
 */
function saveInterestingPost({ url, text, authorUsername, emotion } = {}) {
  if (!url) return;
  const entries = loadCache();
  // Deduplicate by URL
  if (entries.some((e) => e.url === url)) return;
  entries.unshift({
    url,
    text: String(text || "").slice(0, 200),
    authorUsername: authorUsername || null,
    emotion: emotion || null,
    savedAt: Date.now(),
  });
  saveCache(entries.slice(0, MAX_ENTRIES));
}

/**
 * Get interesting posts saved within the last 6 hours, most recent first.
 * @param {number} n
 * @returns {{ url, text, authorUsername, emotion, savedAt }[]}
 */
function getRecentInterestingPosts(n = 5) {
  const cutoff = Date.now() - SIX_HOURS_MS;
  return loadCache()
    .filter((e) => e.savedAt >= cutoff)
    .slice(0, n);
}

module.exports = { saveInterestingPost, getRecentInterestingPosts };
