const { clamp } = require("../utils/math");

const MAX_MOOD_EVENTS = 20;
const MOOD_TICK_MS = 30 * 1000;

const moodHistory = [];
let currentMood = "CALM";
let moodScore = 0;
let lastMoodTickAt = Date.now();

function getDatePartsInTimezone(timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  });

  const parts = formatter.formatToParts(new Date());
  const weekday = parts.find((part) => part.type === "weekday")?.value || "Mon";
  const hour = Number(parts.find((part) => part.type === "hour")?.value || "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value || "0");

  return { weekday, hour, minute };
}

function isWeekendWeekday(weekday) {
  return weekday === "Sun" || weekday === "Sat";
}

function getBaseMood(weekday, hour, minute) {
  const decimalHour = hour + (minute / 60);

  if (isWeekendWeekday(weekday)) {
    if (decimalHour >= 10 && decimalHour < 18) {
      return "PLAYFUL";
    }
    if (decimalHour >= 18 && decimalHour < 23) {
      return "CURIOUS";
    }
    if (decimalHour >= 23 || decimalHour < 2) {
      return "CALM";
    }
    return "CALM";
  }

  if (decimalHour >= 19 && decimalHour < 21) {
    return "PLAYFUL";
  }
  if (decimalHour >= 21 && decimalHour < 23.5) {
    return "CURIOUS";
  }
  if (decimalHour >= 23.5 || decimalHour < 2) {
    return "TIRED";
  }
  return "CALM";
}

function getBaseBias(baseMood) {
  switch (baseMood) {
    case "PLAYFUL":
      return 1.2;
    case "CURIOUS":
      return 0.6;
    case "TIRED":
      return -0.8;
    default:
      return 0;
  }
}

function resolveMoodByScore(score) {
  if (score > 6) return "PLAYFUL";
  if (score > 2) return "CURIOUS";
  if (score > -2) return "CALM";
  if (score > -6) return "TIRED";
  return "WITHDRAWN";
}

function tickMood(timezone = "Asia/Taipei") {
  const now = Date.now();
  if (now - lastMoodTickAt < MOOD_TICK_MS) {
    return;
  }

  const { weekday, hour, minute } = getDatePartsInTimezone(timezone);
  const baseMood = getBaseMood(weekday, hour, minute);
  const baseBias = getBaseBias(baseMood);

  moodScore = clamp((moodScore * 0.96) + baseBias, -10, 10);
  currentMood = resolveMoodByScore(moodScore);
  lastMoodTickAt = now;
}

function recordMoodEvent(event = {}) {
  const delta = Number(event.delta || 0);
  moodScore = clamp(moodScore + delta, -10, 10);

  moodHistory.push({
    timestamp: new Date().toISOString(),
    type: event.type || "unknown",
    targetUser: event.targetUser || null,
    delta,
    reason: event.reason || "",
    mood: currentMood,
  });

  if (moodHistory.length > MAX_MOOD_EVENTS) {
    moodHistory.shift();
  }

  return {
    mood: currentMood,
    moodScore: Number(moodScore.toFixed(2)),
    delta,
  };
}

function getRecentMoodEvents(limit = 5) {
  return moodHistory.slice(-limit).reverse();
}

function generateSelfNarrative(state) {
  if (state.activityTime && state.mood === "CURIOUS") {
    return "今天晚上好像特別想看看大家在做什麼。";
  }
  if (state.activityTime && state.mood === "PLAYFUL") {
    return "現在心情有點輕飄飄的，會想多看看有趣的東西。";
  }
  if (state.drive >= 12) {
    return "有點坐不住，想滑一下。";
  }
  if (state.activeChats > 0) {
    return "現在比較想聊天。";
  }
  if (state.mood === "TIRED" || state.mood === "WITHDRAWN") {
    return "今天有點想安靜一點。";
  }
  return "先靜靜待著看看。";
}

function getCurrentMood(timezone = "Asia/Taipei", context = {}) {
  tickMood(timezone);
  const { weekday, hour, minute } = getDatePartsInTimezone(timezone);
  const baseMood = getBaseMood(weekday, hour, minute);
  const activityTime = isWeekendWeekday(weekday) || hour >= 19 || hour < 2;

  return {
    mood: currentMood,
    reason: generateSelfNarrative({
      mood: currentMood,
      drive: Number(context.drive || 0),
      activeChats: Number(context.activeChats || 0),
      activityTime,
    }),
    baseMood,
    drifted: currentMood !== baseMood,
    moodScore: Number(moodScore.toFixed(2)),
  };
}

function getMoodReadDelay(mood) {
  switch (mood) {
    case "PLAYFUL":
      return 600 + Math.random() * 800;
    case "CURIOUS":
      return 1200 + Math.random() * 1500;
    case "TIRED":
    case "WITHDRAWN":
      return 2000 + Math.random() * 2000;
    default:
      return 1000 + Math.random() * 800;
  }
}

module.exports = {
  getCurrentMood,
  getMoodReadDelay,
  recordMoodEvent,
  getRecentMoodEvents,
};
