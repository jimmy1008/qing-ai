const fs = require("fs");
const path = require("path");

const IDENTITIES_DIR = path.join(__dirname, "../memory/identities");
const SELF_PROFILE_PATH = path.join(__dirname, "../memory/self_profile.json");

function ensureDir() {
  fs.mkdirSync(IDENTITIES_DIR, { recursive: true });
}

function getIdentityCorePath(globalUserKey) {
  if (!globalUserKey || globalUserKey === "global_self") {
    return SELF_PROFILE_PATH;
  }
  return path.join(IDENTITIES_DIR, `${globalUserKey}.json`);
}

function createEmptyIdentityCore() {
  return {
    stableFacts: {},
    preferences: {},
    relationship: {
      familiarity: 0,
      bondType: "normal",
      lastInteraction: null,
    },
  };
}

function getIdentityCore(globalUserKey) {
  ensureDir();
  const targetPath = getIdentityCorePath(globalUserKey);
  if (!fs.existsSync(targetPath)) {
    return createEmptyIdentityCore();
  }

  try {
    const raw = JSON.parse(fs.readFileSync(targetPath, "utf-8"));
    return {
      stableFacts: raw.stableFacts || {},
      preferences: raw.preferences || {},
      relationship: raw.relationship || {
        familiarity: 0,
        bondType: "normal",
        lastInteraction: null,
      },
    };
  } catch {
    return createEmptyIdentityCore();
  }
}

function saveIdentityCore(globalUserKey, core) {
  ensureDir();
  fs.writeFileSync(
    getIdentityCorePath(globalUserKey),
    JSON.stringify(core, null, 2),
    "utf-8",
  );
}

function updateIdentityCore(globalUserKey, fact, meta = {}) {
  if (!globalUserKey || !fact || !fact.type || fact.value === undefined) return null;

  const core = getIdentityCore(globalUserKey);
  const existing = core.stableFacts[fact.type];
  const nextConfidence = Number(fact.confidence || 0);

  if (!existing || nextConfidence > Number(existing.confidence || 0)) {
    core.stableFacts[fact.type] = {
      value: fact.value,
      confidence: nextConfidence,
      source: meta.source || fact.source || "unknown",
      lastUpdated: Number(meta.timestamp || Date.now()),
    };
    saveIdentityCore(globalUserKey, core);
  }

  return core;
}

function syncIdentityRelationship(globalUserKey, relationship = {}) {
  if (!globalUserKey) return null;
  const core = getIdentityCore(globalUserKey);
  core.relationship = {
    familiarity: Number(relationship.familiarity || 0),
    bondType: relationship.bondType || "normal",
    lastInteraction: Number(relationship.lastInteractionAt || relationship.lastInteraction || 0) || null,
  };
  saveIdentityCore(globalUserKey, core);
  return core;
}

function syncIdentityRole(globalUserKey, role) {
  if (!globalUserKey || !role) return null;
  return updateIdentityCore(globalUserKey, {
    type: "role",
    value: role,
    confidence: 1,
    source: "system",
  });
}

function buildStableFactsPrompt(identityCore = {}) {
  const stableFacts = identityCore.stableFacts || {};
  const lines = [];

  if (stableFacts.birthday?.value) {
    lines.push(`Birthday: ${stableFacts.birthday.value}`);
  }
  if (stableFacts.role?.value) {
    lines.push(`Role: ${stableFacts.role.value}`);
  }
  if (stableFacts.name?.value) {
    lines.push(`Name: ${stableFacts.name.value}`);
  }

  return lines.join("\n");
}

module.exports = {
  getIdentityCore,
  updateIdentityCore,
  syncIdentityRelationship,
  syncIdentityRole,
  buildStableFactsPrompt,
};
