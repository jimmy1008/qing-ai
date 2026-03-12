const fs = require("fs");
const path = require("path");

const memoryStore = require("../memory/memory_store");
const { getCurrentMood, getRecentMoodEvents } = require("./mood_engine");
const { getInertiaState, getRecentStateHistory } = require("./inertia_engine");
const { isWithinActiveHours, getDriveContext, getLastSchedulerResult } = require("./threads_activity_scheduler");
const { getPausedChatIds } = require("../security/conversation_guard");

const EVENT_LOG_PATH = path.join(__dirname, "../logs/events.log");
const CONNECTOR_LOG_PATH = path.join(__dirname, "../logs/connector.log");

const thoughtRuntime = {
  lastTalkSummary: "",
  initiativeStatus: {
    shouldInitiate: false,
    targetUserId: null,
    initiativeContext: null,
    reasonCodes: [],
  },
  whyNow: "先靜靜待著看看。",
  lastInteractionUserId: null,
};

function updateThoughtRuntime(next = {}) {
  if (!next || typeof next !== "object") return;
  if ("lastTalkSummary" in next) thoughtRuntime.lastTalkSummary = next.lastTalkSummary || "";
  if ("initiativeStatus" in next && next.initiativeStatus) {
    thoughtRuntime.initiativeStatus = {
      shouldInitiate: Boolean(next.initiativeStatus.shouldInitiate),
      targetUserId: next.initiativeStatus.targetUserId || null,
      initiativeContext: next.initiativeStatus.initiativeContext || null,
      reasonCodes: Array.isArray(next.initiativeStatus.reasonCodes) ? next.initiativeStatus.reasonCodes : [],
    };
  }
  if ("whyNow" in next) thoughtRuntime.whyNow = next.whyNow || thoughtRuntime.whyNow;
  if ("lastInteractionUserId" in next) thoughtRuntime.lastInteractionUserId = next.lastInteractionUserId || null;
}

function readRecentEventRows(limit = 200) {
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

function readLatestConnectorTelemetry() {
  if (!fs.existsSync(CONNECTOR_LOG_PATH)) return null;
  const raw = fs.readFileSync(CONNECTOR_LOG_PATH, "utf-8").trim();
  if (!raw) return null;
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const row = JSON.parse(lines[i]);
      const telemetry = row?.telemetry && typeof row.telemetry === "object" ? row.telemetry : row;
      if (telemetry && typeof telemetry === "object") return telemetry;
    } catch {
      // continue scanning backward
    }
  }
  return null;
}

function pickRuntimeLayerFields(telemetry) {
  if (!telemetry) return null;
  const superego = telemetry.superego || {};
  return {
    idImpulses: telemetry.idImpulses || [],
    idAffect: telemetry.idAffect || {},
    egoArchetype: telemetry.egoArchetype || null,
    sceneGateResult: telemetry.sceneGateResult || null,
    memoryGateResult: telemetry.memoryGateResult || null,
    intimacyGateResult: telemetry.intimacyGateResult || null,
    alignmentScore: telemetry.alignmentScore ?? null,
    historyLength: telemetry.historyLength ?? null,
    speakerCount: telemetry.speakerCount ?? null,
    promptLength: telemetry.promptLength ?? null,
    chatMode: telemetry.chatMode || null,
    currentSpeaker: telemetry.currentSpeaker || null,
    targetSpeaker: telemetry.targetSpeaker || null,
    echoDetected: Boolean(telemetry.echoDetected),
    echoRegenerated: Boolean(telemetry.echoRegenerated),
    echoReason: telemetry.echoReason || "none",
    superego: {
      violations: Array.isArray(superego.violations) ? superego.violations : [],
      rewriteRequired: Boolean(superego.rewriteRequired),
    },
    stateModel: telemetry.stateModel || null,
  };
}

function isInvalidDisplayName(name) {
  if (!name) return true;
  if (/^\d+$/.test(name)) return true;
  if (["friend-99", "user-42"].includes(name)) return true;
  return false;
}

function getNicknameByUserId(userId) {
  if (!userId && userId !== 0) return null;
  const memory = memoryStore.getIdentityMemory(userId);
  const longTerm = memory?.longTerm || {};
  const profile = longTerm.userProfile || longTerm.developerProfile || null;
  const displayName = [profile?.firstName, profile?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim() || profile?.username || null;

  if (isInvalidDisplayName(displayName)) return null;
  return displayName;
}

function getRecentInteractions(limit = 5) {
  const rows = readRecentEventRows(200)
    .filter((row) => row.userId && ["message", "mention", "new_comment"].includes(row.type))
    .slice(-limit)
    .reverse();

  return rows
    .map((row) => ({
      userId: row.userId,
      nickname: getNicknameByUserId(row.userId),
      type: row.type || "unknown",
      intent: row.intent || "none",
      timestamp: row.timestamp || null,
    }))
    .filter((row) => row.nickname);
}

function getTopFamiliarUsers(limit = 5) {
  const items = [];

  for (const [key, memory] of memoryStore.memoryMap.entries()) {
    if (!key.startsWith("identity:")) continue;

    const relationship = memory?.relationship || {};
    const longTerm = memory?.longTerm || {};
    const userId = key.replace("identity:", "");
    const nickname = getNicknameByUserId(userId);
    if (!nickname) continue;

    items.push({
      userId,
      nickname,
      familiarity: relationship.familiarity || 0,
      familiarityScore: relationship.familiarityScore || 0,
      role: longTerm.role || "public_user",
      tags: Array.isArray(relationship.tags) ? relationship.tags : [],
    });
  }

  return items
    .sort((a, b) => (b.familiarity || 0) - (a.familiarity || 0))
    .slice(0, limit);
}

function buildLastTalkSummary(lastInteractions) {
  const first = lastInteractions[0];
  if (!first) return "";
  return `${first.nickname} 剛剛有來找我。`;
}

function getCurrentIntent(drive, driveContext, inertiaState) {
  if (inertiaState?.currentIntent) {
    return inertiaState.currentIntent;
  }
  if (drive >= 12 && isWithinActiveHours()) return "scrolling";
  if ((driveContext?.activeChatCount || 0) > 0) return "chatting";
  return "idle";
}

function getAISnapshot() {
  const inertiaState = getInertiaState();
  const driveContext = getDriveContext();
  const drive = Number((inertiaState.drive || 0).toFixed(2));
  const moodState = getCurrentMood("Asia/Taipei", {
    drive,
    activeChats: driveContext.activeChatCount || 0,
  });
  const lastInteractions = getRecentInteractions(5);

  const runtimeLayer = pickRuntimeLayerFields(readLatestConnectorTelemetry());

  return {
    mood: moodState,
    drive,
    activityIntent: getCurrentIntent(drive, driveContext, inertiaState),
    activityWindowOpen: isWithinActiveHours(),
    lastInteractions,
    emotionalEvents: getRecentMoodEvents(5),
    topFamiliarUsers: getTopFamiliarUsers(5),
    pausedChats: getPausedChatIds(),
    lastScrollAt: inertiaState.lastScrollAt || null,
    activeChatCount: driveContext.activeChatCount || 0,
    unansweredInitiations: driveContext.unansweredInitiations || 0,
    isChatSilent: Boolean(driveContext.isChatSilent),
    whyNow: thoughtRuntime.whyNow || inertiaState.lastWhyNow || moodState.reason,
    lastTalkSummary: thoughtRuntime.lastTalkSummary || buildLastTalkSummary(lastInteractions),
    initiativeStatus: thoughtRuntime.initiativeStatus,
    runtimeLayer,
  };
}

function getAIThoughtsSnapshot() {
  const inertiaState = getInertiaState();
  const driveContext = getDriveContext();
  const schedulerState = getLastSchedulerResult();
  const lastInteractions = getRecentInteractions(5);
  const topFamiliarUsers = getTopFamiliarUsers(5);
  const moodState = getCurrentMood("Asia/Taipei", {
    drive: inertiaState.drive || 0,
    activeChats: driveContext.activeChatCount || 0,
  });

  return {
    currentMood: moodState.mood,
    moodScore: moodState.moodScore,
    drive: Number((inertiaState.drive || 0).toFixed(2)),
    currentIntent: getCurrentIntent(inertiaState.drive || 0, driveContext, inertiaState),
    lastTalkSummary: thoughtRuntime.lastTalkSummary || buildLastTalkSummary(lastInteractions),
    whyNow: thoughtRuntime.whyNow || inertiaState.lastWhyNow || moodState.reason,
    recentEmotionEvents: getRecentMoodEvents(5),
    initiativeStatus: thoughtRuntime.initiativeStatus,
    threadsStatus: {
      activityWindowOpen: isWithinActiveHours(),
      lastScrollAt: inertiaState.lastScrollAt || null,
      urgeToScroll: Number((inertiaState.urgeToScroll || 0).toFixed(2)),
      lastSchedulerResult: schedulerState,
    },
    topFamiliarUsers,
    lastInteractions,
    pausedChats: getPausedChatIds(),
    stateHistory: getRecentStateHistory(10),
  };
}

module.exports = {
  getAISnapshot,
  getAIThoughtsSnapshot,
  updateThoughtRuntime,
};
