const fs = require("fs");
const path = require("path");
const developerConfig = require("../config/developer_config");

const MAP_PATH = path.join(__dirname, "../memory/platform_user_map.json");

function loadStore() {
  if (!fs.existsSync(MAP_PATH)) {
    return {
      nextId: 1,
      platformUserMap: {},
      globalProfiles: {},
    };
  }

  try {
    const raw = fs.readFileSync(MAP_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      nextId: Number(parsed.nextId || 1),
      platformUserMap: parsed.platformUserMap || {},
      globalProfiles: parsed.globalProfiles || {},
    };
  } catch {
    return {
      nextId: 1,
      platformUserMap: {},
      globalProfiles: {},
    };
  }
}

const store = loadStore();

function saveStore() {
  fs.mkdirSync(path.dirname(MAP_PATH), { recursive: true });
  fs.writeFileSync(MAP_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function normalizePlatform(platform = "unknown") {
  return String(platform || "unknown").toLowerCase();
}

function buildPlatformKeys(ref = {}) {
  const platform = normalizePlatform(ref.platform || ref.connector);
  const keys = [];
  if (ref.userId || ref.userId === 0) {
    keys.push(`${platform}:${String(ref.userId)}`);
  }
  if (platform.startsWith("threads") && ref.username) {
    keys.push(`${platform}:username:${String(ref.username).toLowerCase()}`);
  }
  return keys;
}

function isDeveloperRef(ref = {}) {
  const platform = normalizePlatform(ref.platform || ref.connector);
  const telegramIds = (developerConfig.telegram?.ids || []).map(String);
  const threadsIds = (developerConfig.threads?.ids || []).map(String);
  const rawId = String(ref.userId || "");

  if (platform === "telegram" && telegramIds.includes(rawId)) {
    return true;
  }

  if ((platform === "threads" || platform === "threads_dm") && threadsIds.includes(rawId)) {
    return true;
  }

  return String(ref.role || "") === "developer";
}

function ensureGlobalProfile(globalUserKey, ref = {}) {
  if (!store.globalProfiles[globalUserKey]) {
    store.globalProfiles[globalUserKey] = {
      createdAt: Date.now(),
      links: [],
    };
  }

  const profile = store.globalProfiles[globalUserKey];
  const keys = buildPlatformKeys(ref);
  keys.forEach((key) => {
    if (!profile.links.includes(key)) {
      profile.links.push(key);
    }
  });
}

function allocateGlobalKey() {
  const next = `global_${String(store.nextId).padStart(3, "0")}`;
  store.nextId += 1;
  return next;
}

function getOrCreateGlobalUserKey(ref = {}) {
  if (!ref) return "global_unknown";
  if (typeof ref === "string" && ref.startsWith("global_")) return ref;

  const platformKeys = buildPlatformKeys(ref);

  if (isDeveloperRef(ref)) {
    const developerKey = "global_developer";
    platformKeys.forEach((key) => {
      store.platformUserMap[key] = developerKey;
    });
    ensureGlobalProfile(developerKey, ref);
    saveStore();
    return developerKey;
  }

  for (const key of platformKeys) {
    if (store.platformUserMap[key]) {
      const existing = store.platformUserMap[key];
      ensureGlobalProfile(existing, ref);
      saveStore();
      return existing;
    }
  }

  const nextKey = allocateGlobalKey();
  platformKeys.forEach((key) => {
    store.platformUserMap[key] = nextKey;
  });
  ensureGlobalProfile(nextKey, ref);
  saveStore();
  return nextKey;
}

/**
 * Check if a user ref already has a global key (without creating one).
 * Returns true if known, false if this would be a brand-new user.
 */
function isKnownUser(ref = {}) {
  if (!ref) return true; // unknown ref → don't flag as new
  if (isDeveloperRef(ref)) return true;
  const platformKeys = buildPlatformKeys(ref);
  return platformKeys.some((key) => !!store.platformUserMap[key]);
}

function resolveStoredGlobalKey(identifier) {
  if (!identifier && identifier !== 0) return "global_unknown";
  const raw = String(identifier);
  if (raw.startsWith("global_")) return raw;

  const direct = Object.entries(store.platformUserMap).find(([, globalKey]) => globalKey === raw);
  if (direct) return raw;

  const exact = Object.keys(store.platformUserMap).find((key) => key.endsWith(`:${raw}`));
  if (exact) return store.platformUserMap[exact];

  return `global_${raw}`;
}

function getGlobalProfile(globalUserKey) {
  return store.globalProfiles[globalUserKey] || null;
}

function getPlatformUserMap() {
  return { ...store.platformUserMap };
}

module.exports = {
  MAP_PATH,
  buildPlatformKeys,
  getOrCreateGlobalUserKey,
  resolveStoredGlobalKey,
  getGlobalProfile,
  getPlatformUserMap,
  isKnownUser,
};
