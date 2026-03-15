const { getThreadsContext } = require("../connectors/threads_browser/browser_manager");
const { scanFeed } = require("../connectors/threads_browser/feed_scanner");
const { evaluateLikeScore } = require("./like_evaluator");
const { ingestEvent } = require("./memory_bus");
const { getCurrentMood, getMoodReadDelay, recordMoodEvent } = require("./mood_engine");
const { computeDrive } = require("./drive_engine");
const { tickInertia, markScrollSatiation, getInertiaState } = require("./inertia_engine");
const { getPersonalityBaseline } = require("./personality_baseline");
const { runAutonomousSession } = require("../connectors/threads_browser/executor");
const { runNotificationScan } = require("../connectors/threads_browser/notification_scanner");
const config = require("../config/activity_config");
const { recordHeartbeat } = require("./health/connector_health");
const fs = require("fs");
const path = require("path");

const EVENT_LOG_PATH = path.join(__dirname, "../logs/events.log");
const baseline = getPersonalityBaseline();

let lastManualScanTimestamp = 0;
let schedulerTimer = null;
let notifTimer = null;
let heartbeatTimer = null;
let scanInFlight = false;
let lastSchedulerResult = null;

// Notification scan runs every 10–15 minutes independently
const NOTIF_SCAN_MIN_MS = 10 * 60 * 1000;
const NOTIF_SCAN_MAX_MS = 15 * 60 * 1000;

function getDatePartsInTimezone(timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "2-digit",
    hour12: false,
    timeZone: timezone,
  });
  const parts = formatter.formatToParts(new Date());
  const weekday = parts.find((part) => part.type === "weekday")?.value || "Mon";
  const hour = Number(parts.find((part) => part.type === "hour")?.value || "0");
  return { weekday, hour };
}

function isWeekend(dateParts) {
  return dateParts.weekday === "Sun" || dateParts.weekday === "Sat";
}

function isWithinActiveHours() {
  const now = getDatePartsInTimezone(config.timezone);
  if (isWeekend(now)) return true;
  if (now.hour >= 19) return true;
  if (now.hour < 2) return true;
  return false;
}

function getRecentEventRows(limit = 200) {
  if (!fs.existsSync(EVENT_LOG_PATH)) return [];
  const raw = fs.readFileSync(EVENT_LOG_PATH, "utf-8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function getDriveContext(moodState = {}) {
  const rows = getRecentEventRows(200);
  const now = Date.now();
  const recentChatRows = rows.filter((row) => {
    const ts = Date.parse(row.timestamp || "");
    if (!Number.isFinite(ts)) return false;
    if (now - ts > 20 * 60 * 1000) return false;
    return ["message", "mention", "new_comment"].includes(row.type);
  });

  return {
    mood: moodState.mood || "CALM",
    isChatSilent: recentChatRows.length === 0,
    activeChatCount: recentChatRows.length,
    unansweredInitiations: 0,
  };
}

function detectThreadsLoginIssue(debug) {
  const preview = String(debug?.bodyTextPreview || "");
  const patterns = [
    /log in/i,
    /sign in/i,
    /continue with instagram/i,
    /\u767b\u5165/,
    /\u8a3b\u518a/,
  ];
  return patterns.some((pattern) => pattern.test(preview));
}

function canRunScan() {
  const now = Date.now();
  return now - lastManualScanTimestamp > 60 * 60 * 1000;
}

function setSchedulerResult(result) {
  lastSchedulerResult = {
    timestamp: new Date().toISOString(),
    ...result,
  };
}

function getLastSchedulerResult() {
  return lastSchedulerResult;
}

async function runAutoScan() {
  if (scanInFlight) {
    return { skipped: true, reason: "scan_in_flight" };
  }

  if (!isWithinActiveHours()) {
    return { skipped: true, reason: "outside_active_hours" };
  }

  if (!canRunScan()) {
    return { skipped: true, reason: "hourly_limit" };
  }

  scanInFlight = true;
  lastManualScanTimestamp = Date.now();

  try {
    const context = await getThreadsContext();
    const page = context.pages()[0] || await context.newPage();
    const moodState = getCurrentMood(config.timezone);

    await page.goto("https://www.threads.com/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    for (let i = 0; i < 3; i += 1) {
      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(1000);
    }

    const { posts, debug } = await scanFeed(page, 8);
    const proposals = [];

    if (detectThreadsLoginIssue(debug)) {
      return {
        skipped: true,
        reason: "login_checkpoint",
        mood: moodState,
        debug: {
          ...debug,
          note: "Likely not logged in / checkpoint",
        },
      };
    }

    for (const post of posts) {
      await page.waitForTimeout(getMoodReadDelay(moodState.mood));
      const score = evaluateLikeScore(post.text, "public_user_public", moodState.mood);
      ingestEvent({
        platform: "threads",
        channelType: "feed",
        text: post.text,
        timestamp: Date.now(),
        direction: "incoming",
        role: "self",
        eventType: "feed_seen",
        meaningful: score > 0,
        proposalGenerated: false,
        liked: false,
      });
      // Likes are executed directly by autonomousSession — no dashboard queue needed
      if (score >= 3) proposals.push({ text: post.text, score });
    }

    return {
      skipped: false,
      scanned: posts.length,
      evaluated: posts.length,
      proposals: proposals.length,
      mood: moodState,
      debug,
    };
  } finally {
    scanInFlight = false;
  }
}

function nextLoopDelayMs() {
  const [minDelay, maxDelay] = baseline.behaviorLatencyMsRange || [800, 2200];
  const floor = Math.max(90_000, minDelay * 50);
  const ceil = Math.max(180_000, maxDelay * 80);
  return floor + Math.floor(Math.random() * Math.max(1, ceil - floor));
}

async function runAutonomousTick() {
  if (scanInFlight) {
    setSchedulerResult({ skipped: true, reason: "scan_in_flight" });
    return lastSchedulerResult;
  }

  const activityWindowOpen = isWithinActiveHours();
  const moodState = getCurrentMood(config.timezone);
  const driveContext = getDriveContext(moodState);
  const rawDrive = computeDrive(driveContext);
  const inertiaState = tickInertia({
    source: "threads_activity_tick",
    mood: moodState.mood,
    moodScore: moodState.moodScore,
    drive: rawDrive,
    activeChatCount: driveContext.activeChatCount || 0,
    isChatSilent: driveContext.isChatSilent,
    activityWindowOpen,
  });

  if (!activityWindowOpen) {
    recordMoodEvent({ type: "scroll_blocked", delta: -1, reason: "現在不是活動時間。" });
    setSchedulerResult({
      skipped: true,
      reason: "outside_active_hours",
      mood: moodState,
      drive: inertiaState.drive,
      urgeToScroll: inertiaState.urgeToScroll,
      driveContext,
    });
    return lastSchedulerResult;
  }

  if (inertiaState.urgeToScroll < baseline.urgeThreshold) {
    recordMoodEvent({ type: "drive_low", delta: 0, reason: "現在還沒有很想滑文。" });
    setSchedulerResult({
      skipped: true,
      reason: "urge_below_threshold",
      mood: moodState,
      drive: inertiaState.drive,
      urgeToScroll: inertiaState.urgeToScroll,
      driveContext,
    });
    return lastSchedulerResult;
  }

  scanInFlight = true;
  try {
    const result = await runAutonomousSession();
    markScrollSatiation();
    recordMoodEvent({
      type: "scroll_scan",
      delta: result.actionsPerformed > 0 ? 2 : 1,
      reason: result.actionsPerformed > 0 ? "剛剛滑了一下，也按了幾個喜歡。" : "滑了一下，但沒有特別想按喜歡。",
    });
    setSchedulerResult({
      skipped: false,
      reason: "autonomous_scroll",
      mood: moodState,
      drive: getInertiaState().drive,
      urgeToScroll: getInertiaState().urgeToScroll,
      driveContext,
      result,
    });
    return lastSchedulerResult;
  } catch (err) {
    recordMoodEvent({ type: "scroll_blocked", delta: -2, reason: "剛剛想滑文，但沒有成功。" });
    setSchedulerResult({
      skipped: true,
      reason: "autonomous_error",
      mood: moodState,
      drive: inertiaState.drive,
      urgeToScroll: inertiaState.urgeToScroll,
      driveContext,
      error: err.message,
    });
    return lastSchedulerResult;
  } finally {
    scanInFlight = false;
  }
}

function scheduleNextTick() {
  const delay = nextLoopDelayMs();
  schedulerTimer = setTimeout(async () => {
    try {
      await runAutonomousTick();
    } catch (err) {
      console.error("[THREADS SCHEDULER] autonomous tick failed:", err.message);
    } finally {
      scheduleNextTick();
    }
  }, delay);

  return schedulerTimer;
}

function scheduleNextNotifScan() {
  const delay =
    NOTIF_SCAN_MIN_MS +
    Math.floor(Math.random() * (NOTIF_SCAN_MAX_MS - NOTIF_SCAN_MIN_MS));
  notifTimer = setTimeout(async () => {
    try {
      const result = await runNotificationScan();
      console.log(
        `[THREADS SCHEDULER] notification scan: processed=${result.processed} skipped=${result.skipped}`,
      );
    } catch (err) {
      console.error("[THREADS SCHEDULER] notification scan failed:", err.message);
    } finally {
      scheduleNextNotifScan();
    }
  }, delay);
  return notifTimer;
}

function startActivityLoop() {
  if (schedulerTimer) return schedulerTimer;
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      recordHeartbeat("threads", { source: "threads_activity_scheduler" });
    }, 60000);
    recordHeartbeat("threads", { source: "threads_activity_scheduler" });
  }
  scheduleNextNotifScan();
  return scheduleNextTick();
}

module.exports = {
  startActivityLoop,
  runAutoScan,
  isWithinActiveHours,
  canRunScan,
  getDriveContext,
  getLastSchedulerResult,
};
