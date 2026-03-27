const { load, save, saveKey, loadKey } = require("./memory_persistence");
const { compressConversation } = require("./memory_compressor");
const {
  getOrCreateGlobalUserKey,
  resolveStoredGlobalKey,
} = require("../ai/global_identity_map");

const MAX_SHORT_TERM = 20;
const MAX_LONG_TERM = 50;
const MAX_IN_MEMORY = 100; // LRU cap: max users kept in RAM at once
const memoryMap = load();
const _lruOrder = []; // tracks access order for eviction (oldest first)

function _lruTouch(key) {
  const i = _lruOrder.indexOf(key);
  if (i !== -1) _lruOrder.splice(i, 1);
  _lruOrder.push(key);
}

function _lruEvictIfNeeded() {
  while (memoryMap.size > MAX_IN_MEMORY && _lruOrder.length > 0) {
    const evict = _lruOrder.shift();
    const data = memoryMap.get(evict);
    if (data) {
      try { saveKey(evict, data); } catch {}
    }
    memoryMap.delete(evict);
  }
}

function createEmptyMemory() {
  return {
    shortTerm: [],
    summary: "",
    longTerm: {
      knownFacts: [],
      traits: [],
      preferences: [],
      role: "public_user",
      developerProfile: null,
      userProfile: null,
      schedule: {},
    },
    core: {
      knownFacts: [],
    },
    relationship: {
      interactionCount: 0,
      lastInteractionAt: null,
      familiarity: 0,
      familiarityScore: 0,
      familiarityProgress: 0,
      bondType: "normal",
      bondStrength: 0.2,
      tags: [],
      lastTopic: "",
      lastInitiationAt: 0,
      sharedMemories: [],
    },
    preferenceProfile: {
      tags: {},
      avoid: {},
      lastUpdatedAt: null,
      evidence: [],
    },
    relationshipBias: {
      stance: "neutral",
      score: 0,
      lastUpdatedAt: null,
    },
    groupTaste: {
      tags: {},
      avoid: {},
      lastUpdatedAt: null,
      evidence: [],
    },
    impressions: {
      text:       null,   // 晴對這個人的主觀印象（自然語言，繁體中文）
      updated_at: null,
    },
  };
}

function normalizeMemory(memory) {
  if (!memory.summary) memory.summary = "";
  if (!memory.longTerm) {
    memory.longTerm = { knownFacts: [], traits: [], preferences: [], role: "public_user", developerProfile: null, userProfile: null };
  }
  if (!Array.isArray(memory.longTerm.knownFacts)) memory.longTerm.knownFacts = [];
  if (!Array.isArray(memory.longTerm.traits)) memory.longTerm.traits = [];
  if (!Array.isArray(memory.longTerm.preferences)) memory.longTerm.preferences = [];
  if (!memory.longTerm.role) memory.longTerm.role = "public_user";
  if (memory.longTerm.developerProfile === undefined) memory.longTerm.developerProfile = null;
  if (memory.longTerm.userProfile === undefined) memory.longTerm.userProfile = null;
  if (!memory.longTerm.schedule || typeof memory.longTerm.schedule !== "object") memory.longTerm.schedule = {};
  if (!memory.core) memory.core = { knownFacts: [] };
  if (!Array.isArray(memory.core.knownFacts)) memory.core.knownFacts = [];
  if (!memory.relationship) {
    memory.relationship = {
      interactionCount: 0,
      lastInteractionAt: null,
      familiarity: 0,
      familiarityScore: 0,
      familiarityProgress: 0,
      bondType: "normal",
      bondStrength: 0.2,
      tags: [],
      lastTopic: "",
      lastInitiationAt: 0,
    };
  }
  if (memory.relationship.familiarity === undefined) memory.relationship.familiarity = 0;
  if (memory.relationship.familiarityProgress === undefined) memory.relationship.familiarityProgress = 0;
  if (!memory.relationship.bondType) memory.relationship.bondType = "normal";
  if (memory.relationship.bondStrength === undefined) memory.relationship.bondStrength = 0.2;
  if (!Array.isArray(memory.relationship.tags)) memory.relationship.tags = [];
  if (memory.relationship.lastTopic === undefined) memory.relationship.lastTopic = "";
  if (memory.relationship.lastInitiationAt === undefined) memory.relationship.lastInitiationAt = 0;
  if (!Array.isArray(memory.relationship.sharedMemories)) memory.relationship.sharedMemories = [];
  if (!memory.preferenceProfile) {
    memory.preferenceProfile = { tags: {}, avoid: {}, lastUpdatedAt: null, evidence: [] };
  }
  if (!memory.preferenceProfile.tags) memory.preferenceProfile.tags = {};
  if (!memory.preferenceProfile.avoid) memory.preferenceProfile.avoid = {};
  if (!Array.isArray(memory.preferenceProfile.evidence)) memory.preferenceProfile.evidence = [];
  if (!memory.relationshipBias) {
    memory.relationshipBias = { stance: "neutral", score: 0, lastUpdatedAt: null };
  }
  if (!memory.groupTaste) {
    memory.groupTaste = { tags: {}, avoid: {}, lastUpdatedAt: null, evidence: [] };
  }
  if (!memory.groupTaste.tags) memory.groupTaste.tags = {};
  if (!memory.groupTaste.avoid) memory.groupTaste.avoid = {};
  if (!Array.isArray(memory.groupTaste.evidence)) memory.groupTaste.evidence = [];
  return memory;
}

function getMemory(key) {
  if (!memoryMap.has(key)) {
    const fromDisk = loadKey(key);
    memoryMap.set(key, fromDisk || createEmptyMemory());
    if (!fromDisk) saveKey(key, memoryMap.get(key));
    _lruEvictIfNeeded();
  }
  _lruTouch(key);
  const memory = memoryMap.get(key);
  normalizeMemory(memory);
  return memory;
}

function appendShortTerm(key, message) {
  const mem = getMemory(key);
  mem.shortTerm.push(message);
  compressConversation(mem);
  if (mem.shortTerm.length > MAX_SHORT_TERM) {
    mem.shortTerm = mem.shortTerm.slice(-MAX_SHORT_TERM);
  }
  saveKey(key, mem);
}

function addLongTermFact(key, fact) {
  const mem = getMemory(key);
  const normalizedFact = typeof fact === "string"
    ? { fact, confidence: 1, source: "legacy" }
    : fact;

  if (!normalizedFact || !normalizedFact.fact) return;

  const existing = mem.longTerm.knownFacts.find((item) => item.fact === normalizedFact.fact);
  if (existing) {
    if ((normalizedFact.confidence || 0) > (existing.confidence || 0)) {
      existing.confidence = normalizedFact.confidence;
      existing.source = normalizedFact.source || existing.source;
      saveKey(key, mem);
    }
    return;
  }

  mem.longTerm.knownFacts.push(normalizedFact);
  if (mem.longTerm.knownFacts.length > MAX_LONG_TERM) {
    mem.longTerm.knownFacts.shift();
  }
  saveKey(key, mem);
}

function addCoreFact(key, fact) {
  const mem = getMemory(key);
  const normalizedFact = typeof fact === "string"
    ? { fact, confidence: 1, source: "legacy", kind: "core" }
    : fact;

  if (!normalizedFact || !normalizedFact.fact) return;

  const existing = mem.core.knownFacts.find((item) => item.fact === normalizedFact.fact);
  if (existing) {
    if ((normalizedFact.confidence || 0) > (existing.confidence || 0)) {
      existing.confidence = normalizedFact.confidence;
      existing.source = normalizedFact.source || existing.source;
      existing.kind = normalizedFact.kind || existing.kind;
      saveKey(key, mem);
    }
    return;
  }

  mem.core.knownFacts.push(normalizedFact);
  saveKey(key, mem);
}

function setLongTermRole(key, role) {
  const mem = getMemory(key);
  mem.longTerm.role = role;
  saveKey(key, mem);
}

function setDeveloperProfile(key, profile) {
  const mem = getMemory(key);
  mem.longTerm.developerProfile = profile || null;
  if (profile) {
    mem.longTerm.userProfile = profile;
  }
  saveKey(key, mem);
}

function setUserProfile(key, profile) {
  const mem = getMemory(key);
  if (!profile) return;
  mem.longTerm.userProfile = {
    username: profile.username || null,
    firstName: profile.firstName || null,
    lastName: profile.lastName || null,
    language: profile.language || null,
  };
  saveKey(key, mem);
}

function resolveUserRef(userRef) {
  if (!userRef && userRef !== 0) return "global_unknown";

  if (typeof userRef === "string") {
    if (userRef.startsWith("global_")) return userRef;
    if (userRef.startsWith("identity:")) return userRef.slice("identity:".length);
    if (userRef.startsWith("core:")) return userRef.slice("core:".length);
    return resolveStoredGlobalKey(userRef);
  }

  if (typeof userRef === "object") {
    if (userRef.globalUserKey) return String(userRef.globalUserKey);
    return getOrCreateGlobalUserKey({
      platform: userRef.platform || userRef.connector,
      userId: userRef.userId || userRef.fromId || userRef.senderId,
      username: userRef.username,
      role: userRef.role,
    });
  }

  return resolveStoredGlobalKey(userRef);
}

function getMemoryKey(event = {}) {
  const chatId = event.chatId || event.chat?.id || event.groupId || "unknown-group";
  const channel = event.channel || event.channelType || "private";
  return channel === "group" ? `group:${chatId}` : `user:${resolveUserRef(event)}`;
}

function getConversationMemoryKey(event = {}) {
  return getMemoryKey(event);
}

function getIdentityMemoryKey(userRef) {
  return `identity:${resolveUserRef(userRef)}`;
}

function getIdentityMemory(userRef) {
  return getMemory(getIdentityMemoryKey(userRef));
}

function getCoreMemoryKey(userRef) {
  return `core:${resolveUserRef(userRef)}`;
}

function getCoreMemory(userRef) {
  return getMemory(getCoreMemoryKey(userRef));
}

function addSharedMemory(userRef, text, source = "manual") {
  if (!text || !String(text).trim()) return;
  const key = getIdentityMemoryKey(userRef);
  const mem = getMemory(key);
  if (!Array.isArray(mem.relationship.sharedMemories)) mem.relationship.sharedMemories = [];
  mem.relationship.sharedMemories.push({
    text: String(text).slice(0, 120),
    addedAt: Date.now(),
    source,
  });
  saveKey(key, mem);
}

function removeSharedMemory(userRef, index) {
  const key = getIdentityMemoryKey(userRef);
  const mem = getMemory(key);
  if (!Array.isArray(mem.relationship.sharedMemories)) return;
  mem.relationship.sharedMemories.splice(index, 1);
  saveKey(key, mem);
}

function getSharedMemories(userRef) {
  const key = getIdentityMemoryKey(userRef);
  const mem = getMemory(key);
  return Array.isArray(mem.relationship.sharedMemories) ? mem.relationship.sharedMemories : [];
}

// Debounced async persist — coalesces rapid successive calls into one disk write
let _persistTimer = null;
/** Flush all in-memory state to disk. Deferred to next event-loop tick so it never blocks the reply path. */
function persistMemory() {
  if (_persistTimer) return;
  _persistTimer = setImmediate(() => {
    _persistTimer = null;
    try { save(memoryMap); } catch (e) { console.error("[memory] persist error:", e.message); }
  });
}

module.exports = {
  getMemory,
  appendShortTerm,
  addLongTermFact,
  addCoreFact,
  setLongTermRole,
  setDeveloperProfile,
  setUserProfile,
  getMemoryKey,
  getConversationMemoryKey,
  resolveUserRef,
  getIdentityMemoryKey,
  getIdentityMemory,
  getCoreMemoryKey,
  getCoreMemory,
  addSharedMemory,
  removeSharedMemory,
  getSharedMemories,
  persistMemory,
  memoryMap,
};
