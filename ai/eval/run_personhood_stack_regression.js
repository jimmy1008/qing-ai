const fs = require("fs");
const path = require("path");

const { getPersonalityBaseline } = require("../personality_baseline");
const { tickInertia, getRecentStateHistory, getInertiaState, markScrollSatiation } = require("../inertia_engine");
const { getInitiativeDecision } = require("../initiative_engine");
const { getDeveloperBias } = require("../developer_affinity");
const { pauseConversation, resumeConversation, isPaused } = require("../../security/conversation_guard");

const OUT_PATH = path.join(__dirname, "../../train/personhood_stack_regression.json");

function run() {
  const baseline = getPersonalityBaseline();
  const transitions = [];
  for (let i = 0; i < 3; i += 1) {
    transitions.push(tickInertia({
      source: "regression_mood",
      mood: "PLAYFUL",
      moodScore: 10,
      drive: 9,
      activeChatCount: 0,
      isChatSilent: true,
      activityWindowOpen: true,
    }));
  }

  const lowGroup = getInitiativeDecision({
    identity: { channel: "group", role: "public_user", userId: "42" },
    relationshipProfile: { familiarity: 25 },
    relationship: { familiarity: 25, lastInteractionAt: Date.now() },
    identityMemory: { preferenceProfile: { tags: {} } },
    inertiaState: { currentIntent: "idle" },
    silenceStats: { isChatSilent: true },
  });

  const highGroup = getInitiativeDecision({
    identity: { channel: "group", role: "public_user", userId: "99" },
    relationshipProfile: { familiarity: 78 },
    relationship: { familiarity: 78, lastTopic: "系統優化", lastInteractionAt: Date.now() },
    identityMemory: { preferenceProfile: { tags: {} } },
    inertiaState: { currentIntent: "idle" },
    silenceStats: { isChatSilent: true },
  });

  const privateInit = getInitiativeDecision({
    identity: { channel: "private", role: "public_user", userId: "100" },
    relationshipProfile: { familiarity: 65, initiationText: null },
    relationship: { familiarity: 65, lastTopic: "考試", lastInteractionAt: Date.now() },
    identityMemory: { preferenceProfile: { tags: {} } },
    inertiaState: { currentIntent: "idle" },
    silenceStats: { isChatSilent: true },
  });

  const devBias = getDeveloperBias({ role: "developer", channel: "private" }, { familiarity: 100 }, { mood: "CURIOUS" });
  const userBias = getDeveloperBias({ role: "public_user", channel: "private" }, { familiarity: 60 }, { mood: "CURIOUS" });

  const nonActivity = tickInertia({
    source: "regression_non_activity",
    mood: "CALM",
    moodScore: 0,
    drive: 5,
    activeChatCount: 0,
    isChatSilent: false,
    activityWindowOpen: false,
  });
  markScrollSatiation();
  const afterSatiation = getInertiaState();

  const pauseKey = "regression-chat";
  pauseConversation(pauseKey, 15 * 60 * 1000);
  const paused = isPaused(pauseKey);
  resumeConversation(pauseKey);

  const output = {
    tests: [
      {
        name: "mood_inertia_no_jump",
        states: transitions.map((s) => ({ moodScore: s.moodScore, drive: s.drive, intent: s.currentIntent })),
        historyTail: getRecentStateHistory(3),
        maxMoodDeltaPerTick: baseline.moodMaxDeltaPerTick,
      },
      {
        name: "group_initiation_low_vs_high_familiarity",
        lowGroup,
        highGroup,
      },
      {
        name: "private_initiation_uses_last_topic",
        privateInit,
      },
      {
        name: "developer_affinity_delta",
        developer: devBias,
        publicUser: userBias,
      },
      {
        name: "threads_drive_and_satiation",
        nonActivity,
        afterSatiation,
      },
      {
        name: "self_pause_guard",
        paused,
        resumeWorked: !isPaused(pauseKey),
        fixedSentence: "我的AI出問題了幫我跟開發者說一下",
      },
    ],
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}

run();
