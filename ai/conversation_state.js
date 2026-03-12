const personaConfig = require("./persona_config_v2");

const TOPIC_PATTERNS = [
  { topic: "topic_persona", pattern: /(\u4eba\u683c|\u4eba\u8a2d|\u6027\u683c|\u500b\u6027)/ },
  { topic: "topic_review", pattern: /(\u9a57\u6536|\u6e2c\u8a66|\u6aa2\u67e5|\u6821\u6e96)/ },
  { topic: "topic_development", pattern: /(\u958b\u767c|\u8a2d\u8a08|\u5275\u9020|\u8a13\u7df4|\u63a7\u5236\u5c64)/ },
  { topic: "topic_expectation", pattern: /(\u671f\u8a31|\u671f\u5f85|\u5e0c\u671b|\u60f3\u8981\u4f60\u8b8a)/ },
  { topic: "topic_pressure", pattern: /(\u58d3\u529b|\u7126\u616e|\u7d2f|\u5361\u4f4f|\u62d6\u5ef6)/ },
  { topic: "topic_relationship", pattern: /(\u5728\u610f|\u4fe1\u4efb|\u966a\u4f34|\u7406\u89e3|\u8ddd\u96e2\u611f)/ },
];

const state = {
  baselineMood: "curious",
  initiativeLevel: personaConfig.initiativeLevel,
  questionRatio: personaConfig.questionRatioCap,
  topicAnchor: null,
  topicTurnsRemaining: 0,
  lastAssistantEndedWithQuestion: false,
  consecutiveQuestionCount: 0,
  momentumAdjusted: false,
  conversationArc: "opening",
};

/**
 * Derive where the conversation currently is in its arc.
 * opening → deepening → winding_down / topic_shift
 */
function computeConversationArc(history = []) {
  const userMsgs = history.filter((h) => h.role === "user" || h.role === "human");
  const count = userMsgs.length;

  if (count <= 2) return "opening";

  const lengths = userMsgs.map((m) => String(m.text || "").length);
  const avgAll = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const recentLengths = lengths.slice(-3);
  const avgRecent = recentLengths.reduce((a, b) => a + b, 0) / recentLengths.length;

  // Engagement clearly dropping
  if (avgRecent < avgAll * 0.45 && count >= 5) return "winding_down";
  // Deep engagement — consistent length or growing
  if (count >= 4 && avgRecent >= avgAll * 0.75) return "deepening";

  return "chatting";
}

function extractTopic(text = "") {
  for (const { topic, pattern } of TOPIC_PATTERNS) {
    if (pattern.test(text)) return topic;
  }
  return null;
}

function deriveMood(userInput = "") {
  if (/(\u54c8\u54c8|\u7b11\u6b7b|\u597d\u73a9|\u9b27|\u5594|\u6b38)/.test(userInput)) return "playful";
  if (/(\u771f\u7684\u5047\u7684|\u771f\u7684\u55ce|\u662f\u4e0d\u662f|\u4f60\u6562|\u4f60\u78ba\u5b9a)/.test(userInput)) return "sharp";
  if (/(\u7b97\u4e86|\u96a8\u4fbf|\u4e0d\u60f3\u804a|\u9060\u4e00\u9ede)/.test(userInput)) return "distant";
  return "curious";
}

function update(userInput = "", history = [], meta = {}) {
  state.momentumAdjusted = false;
  state.baselineMood = meta.channel === "group" ? "observe" : deriveMood(userInput);

  const topic = extractTopic(userInput);
  if (topic) {
    state.topicAnchor = topic;
    state.topicTurnsRemaining = personaConfig.topicHoldTurns;
  } else if (state.topicTurnsRemaining > 0) {
    state.topicTurnsRemaining -= 1;
  } else {
    state.topicAnchor = null;
  }

  const groupQuestionRatio = meta.channel === "group" ? 0.05 : personaConfig.questionRatioCap;
  const groupInitiativeLevel = meta.channel === "group" ? 0.1 : personaConfig.initiativeLevel;
  state.questionRatio = state.lastAssistantEndedWithQuestion ? 0.1 : groupQuestionRatio;
  state.initiativeLevel = state.topicTurnsRemaining > 0 ? groupInitiativeLevel : 0.5;

  state.conversationArc = computeConversationArc(history);

  return snapshot();
}

function snapshot() {
  return {
    baselineMood: state.baselineMood,
    initiativeLevel: state.initiativeLevel,
    questionRatio: state.questionRatio,
    topicAnchor: state.topicAnchor,
    topicTurnsRemaining: state.topicTurnsRemaining,
    consecutiveQuestionCount: state.consecutiveQuestionCount,
    momentumAdjusted: state.momentumAdjusted,
    conversationArc: state.conversationArc,
  };
}

function registerReply(reply = "") {
  const trimmed = String(reply || "").trim();
  const endedWithQuestion = /[\uff1f?]\s*$/.test(trimmed);
  if (endedWithQuestion) state.consecutiveQuestionCount += 1;
  else state.consecutiveQuestionCount = 0;
  state.lastAssistantEndedWithQuestion = endedWithQuestion;
  return snapshot();
}

module.exports = {
  update,
  registerReply,
  snapshot,
  extractTopic,
};
