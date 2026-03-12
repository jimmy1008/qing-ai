const fs = require("fs");
const path = require("path");
const { PERSONALITY_BASELINE } = require("./personality_baseline");
const { clamp } = require("../utils/math");

const TELEMETRY_PATH = path.join(__dirname, "../telemetry/ai_state_history.jsonl");

let currentState = {
  moodScore: 0,
  drive: 0,
  urgeToScroll: 0,
  currentIntent: "idle",
  lastTickAt: 0,
  lastScrollAt: 0,
  transition: null,
  lastWhyNow: "先靜靜待著看看。",
};

function ensureTelemetryDir() {
  fs.mkdirSync(path.dirname(TELEMETRY_PATH), { recursive: true });
}

function appendHistory(entry) {
  ensureTelemetryDir();
  fs.appendFileSync(TELEMETRY_PATH, `${JSON.stringify(entry)}\n`);
}

function rateLimitedDelta(nextValue, prevValue, maxDelta) {
  if (!Number.isFinite(prevValue)) return nextValue;
  const delta = nextValue - prevValue;
  if (Math.abs(delta) <= maxDelta) return nextValue;
  return prevValue + Math.sign(delta) * maxDelta;
}

function resolveIntent({ drive, activityWindowOpen, activeChatCount }) {
  if (drive >= PERSONALITY_BASELINE.urgeThreshold && activityWindowOpen) {
    return "scrolling";
  }
  if ((activeChatCount || 0) > 0) {
    return "chatting";
  }
  return "idle";
}

function buildWhyNow({ mood, drive, activeChatCount, activityWindowOpen }) {
  if (drive >= PERSONALITY_BASELINE.urgeThreshold && activityWindowOpen) {
    return "有點坐不住，想滑一下。";
  }
  if ((activeChatCount || 0) > 0) {
    return "現在比較想聊天。";
  }
  if (mood === "PLAYFUL") {
    return "現在心情有點輕飄飄的，會想多看看有趣的東西。";
  }
  if (mood === "CURIOUS") {
    return "今天晚上好像特別想看看大家在做什麼。";
  }
  if (mood === "TIRED" || mood === "WITHDRAWN") {
    return "今天有點想安靜一點。";
  }
  return "先靜靜待著看看。";
}

function tickInertia(input = {}) {
  const now = Date.now();
  const minutesElapsed = currentState.lastTickAt
    ? Math.max(0.1, (now - currentState.lastTickAt) / 60000)
    : 1;
  const prevState = { ...currentState };
  const targetMoodScore = Number(input.moodScore ?? 0);
  const targetDrive = Number(input.drive ?? 0);
  const moodScore = rateLimitedDelta(
    targetMoodScore,
    prevState.moodScore,
    PERSONALITY_BASELINE.moodMaxDeltaPerTick,
  );
  const smoothedDrive = Number(((prevState.drive * 0.72) + (targetDrive * 0.28)).toFixed(2));
  const urgeRecovery = minutesElapsed * PERSONALITY_BASELINE.urgeRecoveryPerMinute;
  const urgeTarget = clamp(smoothedDrive, 0, 20);
  const nextUrge = clamp(
    prevState.urgeToScroll + urgeRecovery + ((urgeTarget - prevState.urgeToScroll) * 0.18),
    0,
    20,
  );
  const nextIntent = resolveIntent({
    drive: smoothedDrive,
    activityWindowOpen: Boolean(input.activityWindowOpen),
    activeChatCount: input.activeChatCount || 0,
  });
  const transition = {
    fromMoodScore: prevState.moodScore,
    toMoodScore: Number(moodScore.toFixed(2)),
    fromDrive: prevState.drive,
    toDrive: smoothedDrive,
    fromIntent: prevState.currentIntent,
    toIntent: nextIntent,
    at: new Date(now).toISOString(),
  };

  currentState = {
    moodScore: Number(moodScore.toFixed(2)),
    drive: smoothedDrive,
    urgeToScroll: Number(nextUrge.toFixed(2)),
    currentIntent: nextIntent,
    lastTickAt: now,
    transition,
    lastWhyNow: buildWhyNow({
      mood: input.mood || "CALM",
      drive: smoothedDrive,
      activeChatCount: input.activeChatCount || 0,
      activityWindowOpen: Boolean(input.activityWindowOpen),
    }),
  };

  appendHistory({
    timestamp: transition.at,
    source: input.source || "unknown",
    mood: input.mood || "CALM",
    activityWindowOpen: Boolean(input.activityWindowOpen),
    activeChatCount: input.activeChatCount || 0,
    isChatSilent: Boolean(input.isChatSilent),
    ...transition,
    urgeToScroll: currentState.urgeToScroll,
    whyNow: currentState.lastWhyNow,
  });

  return { ...currentState };
}

function markScrollSatiation() {
  currentState.urgeToScroll = clamp(
    currentState.urgeToScroll - PERSONALITY_BASELINE.urgeSatiationDrop,
    0,
    20,
  );
  currentState.lastTickAt = Date.now();
  currentState.lastScrollAt = Date.now();
}

function getInertiaState() {
  return { ...currentState };
}

function getRecentStateHistory(limit = 20) {
  if (!fs.existsSync(TELEMETRY_PATH)) return [];
  const raw = fs.readFileSync(TELEMETRY_PATH, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").slice(-limit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

module.exports = {
  tickInertia,
  markScrollSatiation,
  getInertiaState,
  getRecentStateHistory,
};
