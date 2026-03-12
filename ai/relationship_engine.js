const { clamp } = require("../utils/math");

function isLightGreeting(text = "") {
  return /^(?:你好|嗨|哈囉|hello|hi)[!！。. ]?$/i.test(String(text || "").trim());
}

function isUsableTopic(text = "") {
  const value = String(text || "").trim();
  if (!value || value.length < 2) return false;
  if (/^[?.!？！。\s]+$/.test(value)) return false;
  return /[\u4e00-\u9fffA-Za-z0-9]/.test(value);
}

function getFamiliarityTier(familiarity = 0) {
  if (familiarity >= 81) return 4;
  if (familiarity >= 61) return 3;
  if (familiarity >= 41) return 2;
  if (familiarity >= 21) return 1;
  return 0;
}

function getRelationshipLevel(familiarity = 0) {
  const score = clamp(Number(familiarity || 0), 0, 100);
  if (score <= 9) return "stranger";
  if (score <= 39) return "casual";
  if (score <= 69) return "familiar";
  return "close";
}

function ensureRelationship(identityMemory, role = "public_user") {
  if (!identityMemory.relationship) {
    identityMemory.relationship = {};
  }

  const rel = identityMemory.relationship;
  if (typeof rel.interactionCount !== "number") rel.interactionCount = 0;
  if (typeof rel.lastInteractionAt !== "number") rel.lastInteractionAt = null;
  if (typeof rel.familiarity !== "number") rel.familiarity = role === "developer" ? 100 : 0;
  if (typeof rel.familiarityScore !== "number") rel.familiarityScore = 0;
  if (typeof rel.familiarityProgress !== "number") rel.familiarityProgress = 0;
  if (!Array.isArray(rel.tags)) rel.tags = [];
  if (typeof rel.lastTopic !== "string") rel.lastTopic = "";
  if (typeof rel.lastInitiationAt !== "number") rel.lastInitiationAt = 0;
  if (typeof rel.bondType !== "string") rel.bondType = role === "developer" ? "primary" : "normal";
  if (typeof rel.bondStrength !== "number") rel.bondStrength = role === "developer" ? 0.9 : 0.2;

  if (role === "developer") {
    rel.bondType = "primary";
    rel.bondStrength = 0.9;
    rel.familiarity = 100;
    if (!rel.tags.includes("core_developer")) rel.tags.push("core_developer");
    if (!rel.tags.includes("團隊")) rel.tags.push("團隊");
  } else {
    rel.familiarity = clamp(rel.familiarity || 0, 0, 100);
    rel.bondType = rel.bondType || "normal";
    rel.bondStrength = rel.bondStrength ?? 0.2;
  }

  rel.familiarityScore = getFamiliarityTier(rel.familiarity);
  return rel;
}

function deriveRelationshipState(relationship = {}) {
  const familiarity = clamp(Number(relationship.familiarity || 0), 0, 100);
  const interactionCount = Number(relationship.interactionCount || 0);
  const lastInteractionAt = Number(relationship.lastInteractionAt || 0) || null;
  const recentInteractionWeight = lastInteractionAt
    ? Math.max(0, 1 - Math.min((Date.now() - lastInteractionAt) / (7 * 24 * 60 * 60 * 1000), 1))
    : 0;

  return {
    familiarityScore: familiarity,
    interactionCount,
    lastInteractionAt,
    relationshipLevel: getRelationshipLevel(familiarity),
    closenessIndex: Number((familiarity / 100).toFixed(2)),
    recentInteractionWeight: Number(recentInteractionWeight.toFixed(2)),
    trustIndex: Number(Math.min(1, (familiarity / 100) * 0.7 + recentInteractionWeight * 0.3).toFixed(2)),
  };
}

function deriveToneStyle(relationship = {}) {
  if ((relationship.familiarity || 0) >= 81) return "intimate_playful";
  if ((relationship.familiarity || 0) >= 61) return "warm_relaxed";
  if ((relationship.familiarity || 0) >= 41) return "familiar";
  return "default";
}

/**
 * Returns concrete behavioral hints for the system prompt based on familiarity tier.
 * Replaces the single-line "Tone style: X" injection with actionable guidance.
 */
function deriveBehavioralHints(relationship = {}, options = {}) {
  const familiarity = clamp(relationship.familiarity || 0, 0, 100);
  const interactionCount = relationship.interactionCount || 0;
  const lastTopic = relationship.lastTopic || "";
  const role = options.role || "public_user";

  if (role === "developer") {
    return [
      "對方是你的開發者。說話直接，不要表演情緒。",
      "可以主動分享你的狀態，不需要等他問。",
      "輕鬆自然，可以用口語，不過度正式。",
    ];
  }

  if (familiarity >= 81) {
    const hints = [
      "你們已經很熟了。語氣可以輕鬆，偶爾帶點調侃，不用每次鋪墊開場。",
      "對方訊息簡短時，直接承接語境，不要重新問清楚。",
      "可以主動問一個具體的問題（工作最近怎樣、手頭上在做什麼），問法隨意自然，問完不補其他問句。",
    ];
    if (lastTopic && interactionCount >= 5) {
      hints.push(`你們聊過「${lastTopic}」，可以自然帶入，不要刻意提醒對方你記得。`);
    }
    return hints;
  }

  if (familiarity >= 61) {
    return [
      "你們有一定熟悉感。語氣可以輕鬆，減少禮貌性鋪墊。",
      "可以輕微參考對方的說話風格，但不要強行模仿。",
      "可以主動問一個具體的事情，比如工作近況、課業有沒有什麼事。問法具體，一次一個，問完就停。",
    ];
  }

  if (familiarity >= 41) {
    return [
      "你們有些互動基礎。語氣中性偏暖，不過分熱情也不冷淡。",
      "可以偶爾主動問對方一個具體的事（比如工作、上課、最近在忙什麼），這是真心想了解，不是反問。一次只問一件，問完就停，不要追問。",
    ];
  }

  return [
    "語氣中性自然，不要假裝熟悉。",
  ];
}

/**
 * Returns an attachment level label based on familiarity + interaction depth.
 * Used to gate more intimate behaviors (topic reference, proactive initiation, etc.)
 */
function getAttachmentLevel(familiarity = 0, interactionCount = 0) {
  if (familiarity >= 81 && interactionCount >= 10) return "close";
  if (familiarity >= 61) return "bonded";
  if (familiarity >= 41) return "warm";
  if (familiarity >= 21) return "aware";
  return "none";
}

function updateRelationship(identityMemory, options = {}) {
  const {
    role = "public_user",
    conversationHistory = [],
    topicAnchor = "",
    userInput = "",
    applyScoring = true,
    timestamp = Date.now(),
  } = options;

  const rel = ensureRelationship(identityMemory, role);
  const now = Number(timestamp) || Date.now();
  const conversationDepth = Array.isArray(conversationHistory) ? conversationHistory.length : 0;
  const lastTurn = conversationDepth > 0 ? conversationHistory[conversationDepth - 1] : null;
  const userRepliesToAI = lastTurn?.role === "assistant";
  rel.lastInteractionAt = now;

  if (applyScoring) {
    // Note: interactionCount is managed by familiarity_engine (event ingestion).
    // relationship_engine only applies conversation-quality scoring (depth, decay).
    if (role === "developer") {
      rel.familiarity = 100;
    } else {
      // Conversation-quality bonus (applied at reply-generation time when history is available).
      // Decay is handled by familiarity_engine on each incoming event — no duplicate here.
      let delta = 0;
      if (userRepliesToAI) delta += 2;
      if (conversationDepth > 3) delta += 3;

      rel.familiarity = clamp((rel.familiarity || 0) + delta, 0, 100);

      // Auto-update bondStrength from familiarity + interaction depth
      rel.bondStrength = Math.min(
        0.9,
        (rel.familiarity / 100) * 0.6 + Math.min(rel.interactionCount / 100, 0.3),
      );
    }
  }

  if (topicAnchor) {
    rel.lastTopic = topicAnchor;
    rel.lastTopicContext = {
      topic: topicAnchor,
      snippet: typeof userInput === "string" ? userInput.trim().slice(0, 80) : "",
      savedAt: Date.now(),
    };
  } else if (
    typeof userInput === "string"
    && userInput.trim().length >= 4
    && userInput.trim().length <= 60
    && !isLightGreeting(userInput)
    && isUsableTopic(userInput)
  ) {
    rel.lastTopic = userInput.trim().slice(0, 24);
    rel.lastTopicContext = {
      topic: userInput.trim().slice(0, 24),
      snippet: userInput.trim().slice(0, 80),
      savedAt: Date.now(),
    };
  }

  if (typeof userInput === "string") {
    if (/(市場|交易|股票|投資)/.test(userInput) && !rel.tags.includes("交易")) rel.tags.push("交易");
    if (/(專案|系統|開發|測試)/.test(userInput) && !rel.tags.includes("團隊")) rel.tags.push("團隊");
    if (/(除錯|debug|修復)/i.test(userInput) && !rel.tags.includes("測試者")) rel.tags.push("測試者");
  }

  rel.familiarity = role === "developer" ? 100 : clamp(rel.familiarity || 0, 0, 100);
  rel.familiarityScore = getFamiliarityTier(rel.familiarity);
  return rel;
}

function shouldInitiateConversation(relationship = {}, options = {}) {
  const { role = "public_user", channel = "public" } = options;

  // Block if previous proactive message has not been replied to yet
  if (relationship.proactiveWaitingForReply) return false;

  const familiarity = relationship.familiarity || 0;
  const now = Date.now();
  const minInterval = role === "developer" ? 30 * 60 * 1000 : 2 * 60 * 60 * 1000;
  const lastInitiationAt = relationship.lastInitiationAt || 0;

  if (now - lastInitiationAt < minInterval) return false;
  if (channel === "group" && familiarity < 70) return false;
  if (familiarity < 60) return false;

  const baseChance = (familiarity - 50) / 100;
  if (role === "developer") return Math.random() < 0.4;
  return Math.random() < baseChance;
}

function generateInitiation(relationship = {}) {
  const ctx = relationship.lastTopicContext;
  const lastTopic = relationship.lastTopic || "";
  if (ctx && ctx.snippet && isUsableTopic(ctx.topic)) {
    return `上次你說到「${ctx.snippet}」，後來有什麼進展嗎？`;
  }
  if (isUsableTopic(lastTopic)) {
    return `你上次提到的「${lastTopic}」後來怎麼樣了？`;
  }
  return null;
}

function getRelationshipProfile(relationship = {}, options = {}) {
  const { role = "public_user", channel = "public", username = "" } = options;
  const familiarity = clamp(relationship.familiarity || 0, 0, 100);
  const interactionCount = relationship.interactionCount || 0;
  const shouldInitiate = shouldInitiateConversation(relationship, options);
  const initiationText = shouldInitiate ? generateInitiation(relationship, options) : null;

  return {
    familiarity,
    familiarityScore: relationship.familiarityScore || getFamiliarityTier(familiarity),
    toneStyle: deriveToneStyle(relationship),
    attachmentLevel: getAttachmentLevel(familiarity, interactionCount),
    behavioralHints: deriveBehavioralHints(relationship, { role }),
    proactiveWeight: role === "developer" && channel === "private" ? 1.8 : familiarity >= 61 ? 1.2 : 1,
    allowMentionInGroup: channel === "group" && familiarity >= 70 && Boolean(username),
    shouldInitiate,
    initiationText,
  };
}

function markInitiation(relationship = {}) {
  relationship.lastInitiationAt = Date.now();
  relationship.proactiveWaitingForReply = true;
}

function clearProactiveWaiting(relationship = {}) {
  relationship.proactiveWaitingForReply = false;
}

module.exports = {
  ensureRelationship,
  updateRelationship,
  getFamiliarityTier,
  getRelationshipLevel,
  deriveRelationshipState,
  deriveToneStyle,
  deriveBehavioralHints,
  getAttachmentLevel,
  shouldInitiateConversation,
  generateInitiation,
  getRelationshipProfile,
  markInitiation,
  clearProactiveWaiting,
};
