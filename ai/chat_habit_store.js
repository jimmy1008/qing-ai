/**
 * chat_habit_store.js
 *
 * Tracks per-user chat habits from real message patterns over time.
 * Fire-and-forget after each incoming private message.
 *
 * Tracked stats (memory/habits/{globalUserKey}.json):
 *   totalMessages, avgLength, hourCounts[24],
 *   shortCount, longCount, questionCount
 *
 * Derived habits (min 15 messages before generating):
 *   - Message length style (短句 / 長篇 / 長短混)
 *   - Active hours (深夜型 / 清晨型 / 白天型 / 傍晚型)
 *   - Communication style (愛發問 / 分享型 / 反應型)
 */

const fs = require("fs");
const path = require("path");

const HABITS_DIR = path.join(__dirname, "../memory/habits");
const MIN_MESSAGES_TO_PROFILE = 15;

function ensureDir() {
  fs.mkdirSync(HABITS_DIR, { recursive: true });
}

function getPath(globalUserKey) {
  ensureDir();
  const safe = String(globalUserKey || "unknown").replace(/[^a-zA-Z0-9_\-]/g, "_");
  return path.join(HABITS_DIR, `${safe}.json`);
}

function load(globalUserKey) {
  const p = getPath(globalUserKey);
  try {
    if (!fs.existsSync(p)) return createEmpty();
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return createEmpty();
  }
}

function save(globalUserKey, data) {
  fs.writeFileSync(getPath(globalUserKey), JSON.stringify(data, null, 2), "utf-8");
}

function createEmpty() {
  return {
    totalMessages: 0,
    totalLength: 0,
    hourCounts: new Array(24).fill(0),
    shortCount: 0,   // < 15 chars
    longCount: 0,    // > 80 chars
    questionCount: 0,
    lastUpdated: null,
  };
}

/**
 * Record one incoming message. Call fire-and-forget.
 * @param {string} globalUserKey
 * @param {string} text - user message text
 * @param {number} [timestamp] - ms epoch (defaults to now)
 */
function trackMessage(globalUserKey, text, timestamp) {
  if (!globalUserKey || !text) return;
  const t = String(text).trim();
  if (!t) return;

  const ts = timestamp || Date.now();
  const hour = new Date(ts).getHours();
  const len = t.length;
  const hasQuestion = /[？?]/.test(t) || /^(什麼|誰|哪|為什麼|怎麼|幾|多少|有沒有|是不是|會不會)/.test(t);

  const data = load(globalUserKey);
  if (!Array.isArray(data.hourCounts) || data.hourCounts.length !== 24) {
    data.hourCounts = new Array(24).fill(0);
  }

  data.totalMessages = (data.totalMessages || 0) + 1;
  data.totalLength = (data.totalLength || 0) + len;
  data.hourCounts[hour] = (data.hourCounts[hour] || 0) + 1;
  if (len < 15) data.shortCount = (data.shortCount || 0) + 1;
  if (len > 80) data.longCount = (data.longCount || 0) + 1;
  if (hasQuestion) data.questionCount = (data.questionCount || 0) + 1;
  data.lastUpdated = ts;

  save(globalUserKey, data);
}

/**
 * Derive peak active period from hourCounts.
 * Returns a label like "深夜型 (00:00–03:00)" or null.
 */
function getPeakPeriodLabel(hourCounts) {
  const total = hourCounts.reduce((s, v) => s + v, 0);
  if (total < 5) return null;

  // Find the 4-hour window with most messages
  let maxCount = 0;
  let peakStart = 0;
  for (let h = 0; h < 24; h++) {
    const window = hourCounts[h] + hourCounts[(h + 1) % 24] + hourCounts[(h + 2) % 24] + hourCounts[(h + 3) % 24];
    if (window > maxCount) { maxCount = window; peakStart = h; }
  }

  if (maxCount / total < 0.25) return null; // no clear peak

  const peakEnd = (peakStart + 4) % 24;
  const fmt = (h) => `${String(h).padStart(2, "0")}:00`;

  if (peakStart >= 22 || peakStart <= 2) return `深夜型 (${fmt(peakStart)}–${fmt(peakEnd)})`;
  if (peakStart >= 3 && peakStart <= 7) return `清晨型 (${fmt(peakStart)}–${fmt(peakEnd)})`;
  if (peakStart >= 8 && peakStart <= 12) return `上午型 (${fmt(peakStart)}–${fmt(peakEnd)})`;
  if (peakStart >= 13 && peakStart <= 17) return `下午型 (${fmt(peakStart)}–${fmt(peakEnd)})`;
  return `傍晚型 (${fmt(peakStart)}–${fmt(peakEnd)})`;
}

/**
 * Build the habit description block for the system prompt.
 * Returns empty string if not enough data yet.
 * @param {string} globalUserKey
 * @returns {string}
 */
function buildHabitBlock(globalUserKey) {
  const data = load(globalUserKey);
  const total = data.totalMessages || 0;
  if (total < MIN_MESSAGES_TO_PROFILE) return "";

  const avgLen = (data.totalLength || 0) / total;
  const shortRatio = (data.shortCount || 0) / total;
  const longRatio = (data.longCount || 0) / total;
  const questionRatio = (data.questionCount || 0) / total;

  const habits = [];

  // Message length style
  if (shortRatio > 0.6) {
    habits.push("習慣發短句，很少長篇大論");
  } else if (longRatio > 0.3) {
    habits.push("喜歡長篇分享，說話有細節");
  } else if (avgLen > 40) {
    habits.push("說話有一定份量，不刻意精簡");
  }

  // Active hours
  const peakPeriod = getPeakPeriodLabel(data.hourCounts || []);
  if (peakPeriod) habits.push(`活躍時間偏向${peakPeriod}`);

  // Communication style
  if (questionRatio > 0.35) {
    habits.push("很常提問，喜歡問東問西");
  } else if (questionRatio < 0.08) {
    habits.push("很少主動發問，多半是分享或反應");
  }

  if (!habits.length) return "";

  return [
    "[User Chat Habits — observed from conversation patterns]",
    "Use these naturally when adapting your tone and pacing. Do not mention them explicitly.",
    ...habits.map((h) => `- ${h}`),
  ].join("\n");
}

module.exports = { trackMessage, buildHabitBlock };
