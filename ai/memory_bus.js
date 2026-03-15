const fs = require("fs");
const path = require("path");
const { appendLine } = require("./memory_service");

const memoryStore = require("../memory/memory_store");
const { evictIfNeeded } = require("../memory/memory_eviction");
const { ensurePreferenceProfile } = require("./preference_profile");
const { updatePreferenceProfile, updateGroupTaste } = require("./preference_updater");
const { ensureRelationship, updateRelationship, clearProactiveWaiting } = require("./relationship_engine");
const { updateFamiliarityFromEvent } = require("./familiarity_engine");
const { recordMoodEvent } = require("./mood_engine");
const { getOrCreateGlobalUserKey } = require("./global_identity_map");
const { extractFacts } = require("./fact_extractor");
const {
  updateIdentityCore,
  syncIdentityRelationship,
  syncIdentityRole,
} = require("./identity_core");
const { recordEmotionalResidue } = require("./emotional_residue");
const { clamp } = require("../utils/math");

const INTERACTIONS_DIR = path.join(__dirname, "../memory/interactions");
const IDENTITIES_DIR = path.join(__dirname, "../memory/identities");
const PREFERENCES_DIR = path.join(__dirname, "../memory/preference_profiles");

function ensureDirs() {
  fs.mkdirSync(INTERACTIONS_DIR, { recursive: true });
  fs.mkdirSync(IDENTITIES_DIR, { recursive: true });
  fs.mkdirSync(PREFERENCES_DIR, { recursive: true });
}

function buildNickname(event = {}) {
  const firstName = String(event.firstName || "").trim();
  const lastName = String(event.lastName || "").trim();
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  return fullName || String(event.username || "").trim() || null;
}

function normalizeBusEvent(input = {}) {
  const platform = String(input.platform || input.connector || "unknown").toLowerCase();
  const channelType = String(input.channelType || input.channel || "private").toLowerCase();
  const timestamp = Number(input.timestamp || Date.now());
  const role = input.role || (channelType === "feed" ? "self" : "public_user");
  const nickname = input.nickname || buildNickname(input);
  const isFeedSelfEvent = channelType === "feed" && !input.userId;
  const globalUserKey = input.globalUserKey || (
    isFeedSelfEvent
      ? "global_self"
      : getOrCreateGlobalUserKey({
        platform,
        userId: input.userId,
        username: input.username,
        role,
      })
  );

  return {
    platform,
    channelType,
    chatId: input.chatId || (channelType === "feed" ? `${platform}_feed` : null),
    userId: isFeedSelfEvent ? "self" : (input.userId || null),
    senderId: input.senderId || input.userId || null,
    senderName: input.senderName || nickname || null,
    globalUserKey,
    nickname,
    text: String(input.text || ""),
    timestamp,
    direction: input.direction || "incoming",
    role,
    username: input.username || null,
    firstName: input.firstName || null,
    lastName: input.lastName || null,
    eventType: input.eventType || "message",
    meaningful: Boolean(input.meaningful),
    proposalGenerated: Boolean(input.proposalGenerated),
    liked: Boolean(input.liked),
  };
}

function getInteractionLogPath(platform = "unknown") {
  return path.join(INTERACTIONS_DIR, `${platform}.jsonl`);
}

function appendInteraction(event) {
  ensureDirs();
  appendLine(getInteractionLogPath(event.platform), JSON.stringify(event)).catch((err) => {
    console.warn("[memory_bus] appendInteraction failed:", err.message);
  });
}

function writeSnapshots(globalUserKey, identityMemory) {
  ensureDirs();
  const identityPath = path.join(IDENTITIES_DIR, `${globalUserKey}.json`);
  const prefPath = path.join(PREFERENCES_DIR, `${globalUserKey}.json`);
  let existing = {};

  if (fs.existsSync(identityPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(identityPath, "utf-8"));
    } catch {
      existing = {};
    }
  }

  fs.writeFileSync(identityPath, JSON.stringify({
    ...existing,
    globalUserKey,
    longTerm: identityMemory.longTerm || {},
    relationship: identityMemory.relationship || {},
    relationshipBias: identityMemory.relationshipBias || {},
  }, null, 2), "utf-8");

  fs.writeFileSync(prefPath, JSON.stringify({
    globalUserKey,
    preferenceProfile: identityMemory.preferenceProfile || {},
  }, null, 2), "utf-8");
}

function shouldPersistFeedEvent(event) {
  if (event.channelType !== "feed") return true;
  return event.meaningful || event.proposalGenerated || event.liked;
}

function isExternalThreadsEvent(event) {
  if (event.platform !== "threads") return false;
  if (event.channelType === "feed") return true;
  if (event.eventType === "external_comment") return true;
  if (event.eventType === "feed_seen") return true;
  if (event.eventType === "feed_like") return true;
  if (event.eventType === "feed_proposal") return true;
  if (event.channelType === "public" && event.role !== "developer" && event.role !== "self") {
    return true;
  }
  return false;
}

function updateFamiliarity(identityMemory, event) {
  if (!event.userId || event.direction !== "incoming") return;

  // Group chats: only update familiarity when the AI is mentioned or replied to
  if (event.channelType === "group" && !event.mentionDetected) return;

  const relationship = ensureRelationship(identityMemory, event.role);
  updateFamiliarityFromEvent(relationship, event, {
    role: event.role,
    developerAffinityMultiplier: 1.35,
  });
}

function updateConversationMemory(event) {
  if (event.channelType !== "private" && event.channelType !== "group") return;

  const conversationKey = memoryStore.getConversationMemoryKey({
    channel: event.channelType,
    channelType: event.channelType,
    chatId: event.chatId,
    platform: event.platform,
    globalUserKey: event.globalUserKey,
    userId: event.userId,
    username: event.username,
    role: event.role,
  });

  memoryStore.appendShortTerm(conversationKey, {
    role: event.direction === "incoming" ? "user" : "bot",
    text: event.text,
    timestamp: event.timestamp,
    platform: event.platform,
    senderId: event.userId || null,
    senderName: event.nickname || event.username || null,
    username: event.username || null,
  });

  if (event.channelType === "group" && event.direction === "incoming") {
    const conversationMemory = memoryStore.getMemory(conversationKey);
    ensurePreferenceProfile(conversationMemory);
    updateGroupTaste(conversationMemory, event.text, `${event.platform}_group`);
  }
}

function updateIdentityMemory(event) {
  if (!event.userId) return null;

  const identityMemoryKey = memoryStore.getIdentityMemoryKey({
    platform: event.platform,
    globalUserKey: event.globalUserKey,
    userId: event.userId,
    username: event.username,
    role: event.role,
  });
  const identityMemory = memoryStore.getMemory(identityMemoryKey);

  ensurePreferenceProfile(identityMemory);
  ensureRelationship(identityMemory, event.role);

  if (event.role === "developer") {
    identityMemory.longTerm.role = "developer";
    identityMemory.relationship.familiarity = Math.max(identityMemory.relationship.familiarity || 0, 60);
    syncIdentityRole(event.globalUserKey, "developer");
  }
  if (event.role === "self") {
    identityMemory.longTerm.role = "self";
    syncIdentityRole(event.globalUserKey, "self");
  }

  if (event.nickname || event.username || event.firstName || event.lastName) {
    memoryStore.setUserProfile(identityMemoryKey, {
      username: event.username || null,
      firstName: event.firstName || null,
      lastName: event.lastName || null,
      language: null,
    });
  }

  updateRelationship(identityMemory, {
    role: event.role,
    conversationHistory: [],
    topicAnchor: "",
    userInput: event.text,
    applyScoring: false,
    timestamp: event.timestamp,
  });
  updateFamiliarity(identityMemory, event);

  if ((event.direction === "incoming" || event.channelType === "feed") && event.text) {
    updatePreferenceProfile(
      identityMemory,
      event.text,
      event.platform === "telegram" ? "telegram_chat" : `${event.platform}_${event.channelType}`,
    );
  }

  // Clear proactive-wait flag when user replies to a private message
  if (event.direction === "incoming" && event.channelType === "private") {
    clearProactiveWaiting(identityMemory.relationship);
  }

  writeSnapshots(event.globalUserKey, identityMemory);
  syncIdentityRelationship(event.globalUserKey, identityMemory.relationship || {});
  return identityMemory;
}

function updateMood(event) {
  if (!event.text) return;
  if (event.role === "developer" && event.direction === "incoming") {
    const reason = "開發者剛剛回了我。";
    recordMoodEvent({
      type: "chat_positive",
      targetUser: event.globalUserKey,
      delta: 2,
      reason,
    });
    recordEmotionalResidue(event.globalUserKey, {
      type: "warm_interaction",
      intensity: 0.7,
      decayRate: 0.95,
      timestamp: event.timestamp,
      reason,
    });
    return;
  }

  if (event.channelType === "group" && event.direction === "incoming") {
    const reason = "群組裡有人在說話。";
    recordMoodEvent({
      type: "group_activity",
      targetUser: event.globalUserKey,
      delta: 1,
      reason,
    });
    recordEmotionalResidue(event.globalUserKey, {
      type: "group_presence",
      intensity: 0.3,
      decayRate: 0.96,
      timestamp: event.timestamp,
      reason,
    });
    return;
  }

  if (event.channelType === "private" && event.direction === "incoming") {
    recordEmotionalResidue(event.globalUserKey, {
      type: "private_interaction",
      intensity: 0.2,
      decayRate: 0.97,
      timestamp: event.timestamp,
      reason: "剛剛和對方有一段私聊。",
    });
    return;
  }

  if (event.channelType === "feed" && event.meaningful) {
    const reason = event.liked ? "剛剛滑到很喜歡的貼文。" : "剛剛看到有點感覺的貼文。";
    recordMoodEvent({
      type: "feed_resonance",
      targetUser: null,
      delta: event.liked ? 2 : 1,
      reason,
    });
    recordEmotionalResidue(event.globalUserKey, {
      type: event.liked ? "liked_feed" : "seen_feed",
      intensity: event.liked ? 0.6 : 0.25,
      decayRate: 0.97,
      timestamp: event.timestamp,
      reason,
    });
  }
}

function updateDeclarativeFacts(event) {
  if (!event.userId || !event.text || event.direction !== "incoming") return;
  const facts = extractFacts(event);
  facts.forEach((fact) => {
    updateIdentityCore(event.globalUserKey, fact, {
      source: event.platform,
      timestamp: event.timestamp,
    });
  });
}

function resolveDomain(event) {
  const platform = String(event.platform || "").toLowerCase();
  if (platform === "threads") return "threads";
  if (platform === "telegram") return "tg";
  if (event.role === "developer") return "developer";
  return platform || "unknown";
}

function ingestEvent(input = {}) {
  const event = normalizeBusEvent(input);
  const domain = resolveDomain(event);

  if (process.env.DEBUG_MEMORY_DOMAIN === "true") {
    console.log(`[MEMORY_BUS] domain=${domain} platform=${event.platform} channel=${event.channelType} userId=${event.userId}`);
  }

  if (!shouldPersistFeedEvent(event)) {
    return { event, domain, persisted: false };
  }

  appendInteraction(event);
  updateConversationMemory(event);

  // Non-blocking eviction check: compress shortTerm if overflowing
  if (event.direction === "outgoing" && event.userId) {
    const conversationKey = memoryStore.getConversationMemoryKey ? memoryStore.getConversationMemoryKey(event) : null;
    if (conversationKey) {
      evictIfNeeded(conversationKey, memoryStore).catch(() => {});
    }
  }

  let identityMemory = null;

  if (!isExternalThreadsEvent(event)) {
    identityMemory = updateIdentityMemory(event);
    updateDeclarativeFacts(event);
  }

  updateMood(event);

  return {
    event,
    domain,
    persisted: true,
    identityMemory,
    writePolicyReason: isExternalThreadsEvent(event) ? "threads_external_scoped" : "default",
  };
}

module.exports = {
  normalizeBusEvent,
  ingestEvent,
  emitEvent: ingestEvent,
};


