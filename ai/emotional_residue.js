const fs = require("fs");
const path = require("path");

const RESIDUE_DIR = path.join(__dirname, "../memory/emotional_residue");
const DEFAULT_DECAY_RATE = 0.65; // ~4-5 turns to fade out
const MIN_INTENSITY = 0.05;
const CACHE_TTL_MS = 30 * 1000; // 30-second in-memory cache

const residueCache = new Map(); // key → { data, expiresAt }

function ensureDir() {
  fs.mkdirSync(RESIDUE_DIR, { recursive: true });
}

function getResiduePath(globalUserKey) {
  return path.join(RESIDUE_DIR, `${globalUserKey || "global_unknown"}.json`);
}

function createEmptyResidue() {
  return {
    recentEmotionalEvents: [],
    baselineMood: "CALM",
    moodDrift: 0,
  };
}

function decayEvents(events = []) {
  return events
    .map((event) => ({
      ...event,
      intensity: Number(((event.intensity || 0) * (event.decayRate || DEFAULT_DECAY_RATE)).toFixed(4)),
    }))
    .filter((event) => (event.intensity || 0) >= MIN_INTENSITY);
}

function getEmotionalResidue(globalUserKey) {
  const cacheEntry = residueCache.get(globalUserKey);
  if (cacheEntry && Date.now() < cacheEntry.expiresAt) {
    return cacheEntry.data;
  }

  ensureDir();
  const targetPath = getResiduePath(globalUserKey);
  if (!fs.existsSync(targetPath)) {
    return createEmptyResidue();
  }

  try {
    const raw = JSON.parse(fs.readFileSync(targetPath, "utf-8"));
    const next = {
      recentEmotionalEvents: decayEvents(raw.recentEmotionalEvents || []),
      baselineMood: raw.baselineMood || "CALM",
      moodDrift: Number(raw.moodDrift || 0),
    };
    fs.writeFileSync(targetPath, JSON.stringify(next, null, 2), "utf-8");
    residueCache.set(globalUserKey, { data: next, expiresAt: Date.now() + CACHE_TTL_MS });
    return next;
  } catch {
    return createEmptyResidue();
  }
}

function saveEmotionalResidue(globalUserKey, residue) {
  ensureDir();
  fs.writeFileSync(getResiduePath(globalUserKey), JSON.stringify(residue, null, 2), "utf-8");
  residueCache.set(globalUserKey, { data: residue, expiresAt: Date.now() + CACHE_TTL_MS });
}

function recordEmotionalResidue(globalUserKey, event = {}) {
  if (!globalUserKey || !event.type) return null;

  const residue = getEmotionalResidue(globalUserKey);
  residue.recentEmotionalEvents.push({
    type: event.type,
    intensity: Number(event.intensity || 0.3),
    decayRate: Number(event.decayRate || DEFAULT_DECAY_RATE),
    timestamp: Number(event.timestamp || Date.now()),
    reason: event.reason || "",
  });
  residue.recentEmotionalEvents = residue.recentEmotionalEvents.slice(-20);
  residue.moodDrift = Number(
    residue.recentEmotionalEvents.reduce((sum, item) => sum + Number(item.intensity || 0), 0).toFixed(4),
  );
  saveEmotionalResidue(globalUserKey, residue);
  return residue;
}

const EMOTION_LABELS = {
  warm_interaction: "warmth / closeness",
  curiosity: "mild curiosity / interest",
  delight: "light playfulness / enjoyment",
  mild_annoyance: "slight edge / mild annoyance",
  distress_awareness: "lingering care / concern",
  ambient: "neutral baseline",
};

function buildEmotionalResiduePrompt(residue = {}) {
  const events = (residue.recentEmotionalEvents || [])
    .filter((e) => (e.intensity || 0) >= MIN_INTENSITY);
  if (!events.length) return "";

  const totalIntensity = events.reduce((sum, e) => sum + (e.intensity || 0), 0);
  if (totalIntensity < 0.12) return "";

  const strongest = events.reduce(
    (max, e) => (e.intensity || 0) > (max.intensity || 0) ? e : max,
    events[0],
  );
  const label = EMOTION_LABELS[strongest.type] || strongest.type;
  const level = totalIntensity >= 0.45 ? "noticeable" : totalIntensity >= 0.2 ? "mild" : "faint";

  return [
    `Lingering emotional tone: ${label} (${level}, intensity ${totalIntensity.toFixed(2)}).`,
    "Let this color the reply — stronger residue may surface explicitly; faint residue shows only in tone.",
    "Transition out naturally. Do not force or prolong this feeling.",
  ].join(" ");
}

module.exports = {
  getEmotionalResidue,
  recordEmotionalResidue,
  buildEmotionalResiduePrompt,
};
