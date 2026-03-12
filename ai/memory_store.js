const persistentMemoryStore = require("../memory/memory_store");
const { clamp } = require("../utils/math");

function getDisplayName(memory = {}) {
  const profile = memory.longTerm?.userProfile || memory.longTerm?.developerProfile || null;
  const firstName = String(profile?.firstName || "").trim();
  const lastName = String(profile?.lastName || "").trim();
  const fullName = `${firstName}${lastName ? ` ${lastName}` : ""}`.trim();
  if (fullName) return fullName;
  const username = String(profile?.username || "").trim();
  return username || null;
}

function getIdentityTruth(userRef) {
  const memory = persistentMemoryStore.getIdentityMemory(userRef);
  const globalUserKey = persistentMemoryStore.resolveUserRef(userRef);
  const familiarity = clamp(Number(memory.relationship?.familiarity || 0), 0, 100);
  return {
    userId: String(globalUserKey || ""),
    nickname: getDisplayName(memory),
    role: memory.longTerm?.role || "public_user",
    knownFacts: Array.isArray(memory.longTerm?.knownFacts) ? memory.longTerm.knownFacts : [],
    relationship: {
      familiarity,
      familiarityScore: familiarity,
      interactionCount: Number(memory.relationship?.interactionCount || 0),
      lastInteractionAt: Number(memory.relationship?.lastInteractionAt || 0) || null,
      tags: Array.isArray(memory.relationship?.tags) ? memory.relationship.tags : [],
      lastTopic: String(memory.relationship?.lastTopic || ""),
      sharedMemories: Array.isArray(memory.relationship?.sharedMemories) ? memory.relationship.sharedMemories : [],
      bondType: memory.relationship?.bondType || "normal",
    },
    preferenceProfile: memory.preferenceProfile || { tags: {}, avoid: {}, evidence: [] },
  };
}

function getConversationTruth(event = {}) {
  const key = persistentMemoryStore.getConversationMemoryKey(event);
  const memory = persistentMemoryStore.getMemory(key);
  return {
    key,
    summary: String(memory.summary || "").trim(),
    shortTerm: Array.isArray(memory.shortTerm) ? memory.shortTerm : [],
    groupTaste: memory.groupTaste || { tags: {}, avoid: {}, evidence: [] },
  };
}

function listTopRelationships(limit = 5) {
  const rows = [];
  for (const [key, memory] of persistentMemoryStore.memoryMap.entries()) {
    if (!key.startsWith("identity:")) continue;
    const nickname = getDisplayName(memory);
    if (!nickname) continue;
    rows.push({
      userId: key.slice("identity:".length),
      nickname,
      familiarityScore: clamp(Number(memory.relationship?.familiarity || 0), 0, 100),
      interactionCount: Number(memory.relationship?.interactionCount || 0),
      lastInteractionAt: Number(memory.relationship?.lastInteractionAt || 0) || null,
    });
  }

  rows.sort((a, b) => {
    if (b.familiarityScore !== a.familiarityScore) return b.familiarityScore - a.familiarityScore;
    return (b.lastInteractionAt || 0) - (a.lastInteractionAt || 0);
  });

  return rows.slice(0, limit);
}

function addSharedMemory(userRef, text, source = "manual") {
  persistentMemoryStore.addSharedMemory(userRef, text, source);
}

function removeSharedMemory(userRef, index) {
  persistentMemoryStore.removeSharedMemory(userRef, index);
}

module.exports = {
  getIdentityTruth,
  getConversationTruth,
  listTopRelationships,
  addSharedMemory,
  removeSharedMemory,
};
