// Tracks group chats and DM users seen in the current session
// Used by telegram_proactive_scheduler to know where to proactively send

const fs   = require("fs");
const path = require("path");

const KNOWN_GROUPS_PATH = path.join(__dirname, "../../memory/known_groups.json");

// Load persisted known groups (chatId → firstSeenTs)
function loadKnownGroups() {
  try {
    if (fs.existsSync(KNOWN_GROUPS_PATH)) return JSON.parse(fs.readFileSync(KNOWN_GROUPS_PATH, "utf-8"));
  } catch {}
  return {};
}

const knownGroupsStore = loadKnownGroups();

function saveKnownGroups() {
  fs.writeFileSync(KNOWN_GROUPS_PATH, JSON.stringify(knownGroupsStore, null, 2), "utf-8");
}

/**
 * Returns true if this is the first time 晴 has seen this group (ever).
 * Side effect: marks it as known.
 */
function checkAndMarkNewGroup(chatId) {
  const key = String(chatId);
  if (knownGroupsStore[key]) return false;
  knownGroupsStore[key] = Date.now();
  saveKnownGroups();
  return true;
}

const MAX_RECENT_MESSAGES = 10;

// chatId → { lastActivity: timestamp, recentMessages: [{ text, userId, username, ts }] }
const groupRegistry = new Map();

// telegramUserId → { chatId, username, firstName, globalKey, lastActivity }
const dmRegistry = new Map();

function registerGroupMessage(chatId, { text = "", userId = null, username = null } = {}) {
  const entry = groupRegistry.get(chatId) || { lastActivity: 0, recentMessages: [] };
  entry.lastActivity = Date.now();
  entry.recentMessages.push({ text, userId, username, ts: Date.now() });
  if (entry.recentMessages.length > MAX_RECENT_MESSAGES) {
    entry.recentMessages.shift();
  }
  groupRegistry.set(chatId, entry);
}

function registerDmUser(telegramUserId, { chatId, username = null, firstName = null, globalKey = null } = {}) {
  dmRegistry.set(telegramUserId, {
    chatId,
    username,
    firstName,
    globalKey,
    lastActivity: Date.now(),
  });
}

// Returns groups with activity within the last withinMs ms (default 30 min)
function getActiveGroups(withinMs = 30 * 60 * 1000) {
  const now = Date.now();
  const results = [];
  for (const [chatId, entry] of groupRegistry.entries()) {
    if (now - entry.lastActivity <= withinMs) {
      results.push({ chatId, ...entry });
    }
  }
  return results;
}

function getKnownDmUsers() {
  return Array.from(dmRegistry.entries()).map(([telegramUserId, info]) => ({
    telegramUserId,
    ...info,
  }));
}

module.exports = { registerGroupMessage, registerDmUser, getActiveGroups, getKnownDmUsers, checkAndMarkNewGroup, groupRegistry };
