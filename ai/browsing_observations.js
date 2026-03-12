const fs = require("fs");
const path = require("path");

const OBS_PATH = path.join(__dirname, "../telemetry/browsing_observations.json");
const MAX_ENTRIES = 10;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(OBS_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(entries) {
  try {
    fs.mkdirSync(path.dirname(OBS_PATH), { recursive: true });
    fs.writeFileSync(OBS_PATH, JSON.stringify(entries, null, 2));
  } catch { /* ignore */ }
}

/**
 * Record a thematic observation from a browsing session.
 * Called once per session with a summary of what was seen.
 * @param {{ summary: string, themes: string[], postCount: number }} obs
 */
function recordObservation({ summary, themes = [], postCount = 0 } = {}) {
  if (!summary) return;
  const entries = load();
  entries.unshift({
    summary: String(summary).slice(0, 200),
    themes: themes.slice(0, 5),
    postCount,
    savedAt: Date.now(),
  });
  save(entries.slice(0, MAX_ENTRIES));
}

/**
 * Get observations from the last 6 hours.
 * @param {number} n
 * @returns {{ summary, themes, postCount, savedAt }[]}
 */
function getRecentObservations(n = 3) {
  const cutoff = Date.now() - SIX_HOURS_MS;
  return load().filter((e) => e.savedAt >= cutoff).slice(0, n);
}

module.exports = { recordObservation, getRecentObservations };
