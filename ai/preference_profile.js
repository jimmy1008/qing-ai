function createPreferenceProfile() {
  return {
    tags: {},
    avoid: {},
    lastUpdatedAt: null,
    evidence: [],
  };
}

function createRelationshipBias() {
  return {
    stance: "neutral",
    score: 0,
    lastUpdatedAt: null,
  };
}

function createGroupTaste() {
  return {
    tags: {},
    avoid: {},
    lastUpdatedAt: null,
    evidence: [],
  };
}

function ensurePreferenceProfile(memory = {}) {
  if (!memory.preferenceProfile) {
    memory.preferenceProfile = createPreferenceProfile();
  }
  if (!memory.relationshipBias) {
    memory.relationshipBias = createRelationshipBias();
  }
  if (!memory.groupTaste) {
    memory.groupTaste = createGroupTaste();
  }
  return memory;
}

module.exports = {
  createPreferenceProfile,
  createRelationshipBias,
  createGroupTaste,
  ensurePreferenceProfile,
};
