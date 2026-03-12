const fs = require("fs");
const path = require("path");

const IMPRESSIONS_PATH = path.join(__dirname, "../telemetry/threads_impressions.json");
const MAX_RECENT_EMOTIONS = 10;
// 30-day half-life: score = likeCount * e^(-days / 30)
const DECAY_HALF_LIFE_DAYS = 30;

function loadImpressions() {
  try {
    if (fs.existsSync(IMPRESSIONS_PATH)) {
      return JSON.parse(fs.readFileSync(IMPRESSIONS_PATH, "utf-8"));
    }
  } catch { /* ignore */ }
  return {};
}

function saveImpressions(data) {
  try {
    fs.mkdirSync(path.dirname(IMPRESSIONS_PATH), { recursive: true });
    fs.writeFileSync(IMPRESSIONS_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch { /* ignore */ }
}

function computeDecayScore(likeCount, lastInteractionAt) {
  if (!likeCount) return 0;
  if (!lastInteractionAt) return likeCount;
  const daysSince = (Date.now() - new Date(lastInteractionAt).getTime()) / (1000 * 60 * 60 * 24);
  return likeCount * Math.exp(-daysSince / DECAY_HALF_LIFE_DAYS);
}

function computeImpression(entry) {
  const decayScore = computeDecayScore(entry.likeCount || 0, entry.lastInteractionAt);
  if (decayScore >= 2.5) return "warm";
  if (decayScore >= 0.8) return "curious";
  return "neutral";
}

function createEmptyEntry() {
  return {
    likeCount: 0,
    commentProposedCount: 0,
    commentExecutedCount: 0,
    viewCount: 0,
    lastInteractionAt: null,
    lastLikedAt: null,
    lastSeenAt: null,
    recentEmotions: [],
    impression: "neutral",
  };
}

function getImpression(authorUsername) {
  if (!authorUsername) return createEmptyEntry();
  const data = loadImpressions();
  return data[authorUsername] || createEmptyEntry();
}

function updateImpression(authorUsername, { event, emotion } = {}) {
  if (!authorUsername) return;
  const data = loadImpressions();
  const entry = data[authorUsername] || createEmptyEntry();

  const now = new Date().toISOString();

  if (event === "like") {
    entry.likeCount = (entry.likeCount || 0) + 1;
    entry.lastLikedAt = now;
    entry.lastInteractionAt = now;
    if (emotion && emotion !== "none") {
      entry.recentEmotions = [emotion, ...(entry.recentEmotions || [])].slice(0, MAX_RECENT_EMOTIONS);
    }
  } else if (event === "comment_proposed") {
    entry.commentProposedCount = (entry.commentProposedCount || 0) + 1;
    entry.lastInteractionAt = now;
  } else if (event === "comment_executed") {
    entry.commentExecutedCount = (entry.commentExecutedCount || 0) + 1;
    entry.lastInteractionAt = now;
  } else if (event === "view") {
    entry.viewCount = (entry.viewCount || 0) + 1;
    // view does not update lastInteractionAt (too cheap to count as interaction)
  } else if (event === "seen") {
    entry.lastSeenAt = now;
  }

  entry.lastSeenAt = entry.lastSeenAt || now;
  entry.impression = computeImpression(entry);

  // Normalize entries that predate the schema
  if (entry.commentExecutedCount === undefined) entry.commentExecutedCount = 0;
  if (entry.viewCount === undefined) entry.viewCount = 0;
  if (entry.lastInteractionAt === undefined) entry.lastInteractionAt = entry.lastLikedAt || null;

  data[authorUsername] = entry;
  saveImpressions(data);
}

function getTopAuthors(n = 10) {
  const data = loadImpressions();
  return Object.entries(data)
    .map(([username, entry]) => {
      const decayScore = computeDecayScore(entry.likeCount || 0, entry.lastInteractionAt);
      return { username, ...entry, decayScore: Number(decayScore.toFixed(3)) };
    })
    .sort((a, b) => b.decayScore - a.decayScore)
    .slice(0, n);
}

function getTotalTracked() {
  const data = loadImpressions();
  return Object.keys(data).length;
}

module.exports = {
  getImpression,
  updateImpression,
  getTopAuthors,
  getTotalTracked,
};
