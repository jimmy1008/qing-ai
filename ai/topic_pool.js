/**
 * topic_pool.js
 * Global rolling pool of conversation topics learned from:
 *   1. Threads browsing (themes that resonated)
 *   2. Real conversations (topics that led to extended exchanges)
 *
 * Injected into system prompt as optional conversation seeds.
 */
const fs = require("fs");
const path = require("path");

const POOL_PATH = path.join(__dirname, "../telemetry/topic_pool.json");
const MAX_TOPICS = 30;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(POOL_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(entries) {
  try {
    fs.mkdirSync(path.dirname(POOL_PATH), { recursive: true });
    fs.writeFileSync(POOL_PATH, JSON.stringify(entries, null, 2));
  } catch { /* ignore */ }
}

/**
 * Add a topic to the pool.
 * @param {{ topic: string, source: "browse"|"conversation", emotion?: string }} entry
 */
function addTopic({ topic, source = "browse", emotion = null } = {}) {
  if (!topic || String(topic).trim().length < 3) return;
  const entries = load();
  const text = String(topic).trim().slice(0, 60);
  // Deduplicate by similar text
  if (entries.some((e) => e.topic === text)) return;
  entries.unshift({ topic: text, source, emotion, addedAt: Date.now() });
  save(entries.slice(0, MAX_TOPICS));
}

/**
 * Get recent topics (last 7 days), most recent first.
 * @param {number} n
 */
function getRecentTopics(n = 5) {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  return load().filter((e) => e.addedAt >= cutoff).slice(0, n);
}

module.exports = { addTopic, getRecentTopics };
