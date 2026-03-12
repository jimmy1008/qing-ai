const fs = require("fs");
const path = require("path");
const { getIdentityTruth, getConversationTruth, listTopRelationships } = require("./memory_store");
const { deriveRelationshipState } = require("./relationship_engine");
const { buildRelationshipNarrative } = require("./relationship_narrative");

const TELEMETRY_DIR = path.join(__dirname, "../telemetry");
const SECURITY_EVENT_PATH = path.join(TELEMETRY_DIR, "security_events.jsonl");

fs.mkdirSync(TELEMETRY_DIR, { recursive: true });

function appendSecurityEvent(entry) {
  fs.appendFileSync(
    SECURITY_EVENT_PATH,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
  );
}

function classifyMemoryQuery(text = "") {
  const normalized = String(text || "").trim();
  if (!normalized) return null;

  // Only explicit system-query terms — "關係" alone is too broad and matches casual questions
  if (/(熟悉度|熟悉排行|熟悉排名|誰最熟|排行榜|排名榜)/.test(normalized)) return "relationship";
  if (/(你記得我嗎|認得我嗎|知道我是誰嗎)/.test(normalized)) return "recognition";
  if (/(聊過什麼|我們聊過什麼|上次聊什麼|最近聊了什麼)/.test(normalized)) return "recent_summary";
  if (/(你喜歡什麼|偏好|你愛看什麼)/.test(normalized)) return "preferences";

  return null;
}

function formatRelationshipLevel(level) {
  const labels = {
    stranger: "陌生",
    casual: "偶爾互動",
    familiar: "熟識",
    close: "親近",
  };
  return labels[level] || "未知";
}

function formatTimestamp(ts) {
  if (!ts) return "尚無紀錄";
  return new Date(ts).toLocaleString("zh-TW", { hour12: false });
}

function buildRecentSummary(conversation = {}) {
  if (conversation.summary) {
    const cleaned = String(conversation.summary).replace(/^Summary:\s*/i, "").trim();
    if (cleaned) return cleaned;
  }

  const recentUserTurns = (conversation.shortTerm || [])
    .filter((item) => item.role === "user" && String(item.text || "").trim())
    .slice(-3)
    .map((item) => String(item.text || "").trim());

  if (recentUserTurns.length === 0) {
    return "目前沒有可用的最近對話摘要。";
  }

  return `最近主要聊到：${recentUserTurns.join("、")}。`;
}

function buildPreferenceSummary(identity = {}) {
  const profile = identity.preferenceProfile || {};
  const likes = Object.entries(profile.tags || {})
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .slice(0, 3)
    .map(([tag]) => tag);
  const avoids = Object.entries(profile.avoid || {})
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .slice(0, 3)
    .map(([tag]) => tag);

  const likeText = likes.length > 0 ? likes.join("、") : "目前沒有明確偏好";
  const avoidText = avoids.length > 0 ? avoids.join("、") : "目前沒有明確避開項";
  return `我現在比較偏向：${likeText}。比較不想碰的是：${avoidText}。`;
}

function buildTopFamiliarSummary(currentUserId) {
  const rows = listTopRelationships(5);
  if (rows.length === 0) {
    return "目前沒有可用的熟悉度排行。";
  }

  const parts = rows.map((item, index) => {
    const selfMark = String(item.userId) === String(currentUserId) ? "（你）" : "";
    return `${index + 1}. ${item.nickname}${selfMark} - ${item.familiarityScore}`;
  });
  return `目前熟悉度排行是：${parts.join("；")}。`;
}

function buildRelationshipReply(context) {
  const identity = getIdentityTruth(context.userId);
  const relationshipState = deriveRelationshipState(identity.relationship);
  const narrative = buildRelationshipNarrative({
    relationshipLevel: relationshipState.relationshipLevel,
    mood: context.moodState?.mood,
    recentInteractionWeight: relationshipState.recentInteractionWeight,
  });

  return {
    queryType: "relationship",
    reply: [
      buildTopFamiliarSummary(context.userId),
      `你目前和我的熟悉度是 ${relationshipState.familiarityScore}。`,
      `我們屬於${formatRelationshipLevel(relationshipState.relationshipLevel)}的關係。`,
      `最近一次互動是在 ${formatTimestamp(relationshipState.lastInteractionAt)}。`,
      `目前的關係描述是：${narrative.description}`,
    ].join(" "),
  };
}

function buildRecognitionReply(context) {
  const identity = getIdentityTruth(context.userId);
  const relationshipState = deriveRelationshipState(identity.relationship);
  const nickname = identity.nickname;

  if (!nickname) {
    return {
      queryType: "recognition",
      reply: `我記得你有和我互動過。你目前和我的熟悉度是 ${relationshipState.familiarityScore}，屬於${formatRelationshipLevel(relationshipState.relationshipLevel)}。`,
    };
  }

  return {
    queryType: "recognition",
    reply: `我記得你是${nickname}。你目前和我的熟悉度是 ${relationshipState.familiarityScore}，屬於${formatRelationshipLevel(relationshipState.relationshipLevel)}。`,
  };
}

function buildRecentSummaryReply(context) {
  const conversation = getConversationTruth(context.event || {});
  return {
    queryType: "recent_summary",
    reply: buildRecentSummary(conversation),
  };
}

function buildPreferencesReply(context) {
  const identity = getIdentityTruth(context.userId);
  return {
    queryType: "preferences",
    reply: buildPreferenceSummary(identity),
  };
}

function routeMemoryQuery(text, context) {
  const queryType = classifyMemoryQuery(text);
  if (!queryType) return null;

  try {
    switch (queryType) {
      case "relationship":
        return buildRelationshipReply(context);
      case "recognition":
        return buildRecognitionReply(context);
      case "recent_summary":
        return buildRecentSummaryReply(context);
      case "preferences":
        return buildPreferencesReply(context);
      default:
        return null;
    }
  } catch (error) {
    appendSecurityEvent({
      type: "memory_query_error",
      userId: context.userId || null,
      channel: context.channel || null,
      queryType,
      message: error.message,
    });
    return {
      queryType: "memory_error",
      error: true,
      reply: "系統記憶異常，請通知開發者。",
    };
  }
}

module.exports = {
  classifyMemoryQuery,
  routeMemoryQuery,
};
