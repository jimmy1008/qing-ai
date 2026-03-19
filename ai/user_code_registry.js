/**
 * user_code_registry.js
 * Assigns a stable short code (u001, u002...) to each userId.
 * Persisted to memory/user_codes.json.
 * Also resolves familiarity level (L1/L2/L3) for gate decisions.
 */

const fs   = require("fs");
const path = require("path");

const REGISTRY_PATH = path.join(__dirname, "../memory/user_codes.json");

let _registry = null;

function load() {
  if (_registry) return _registry;
  try {
    _registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  } catch {
    _registry = { codes: {}, counter: 0 };
  }
  return _registry;
}

function save() {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(_registry, null, 2), "utf8");
}

/**
 * Get or create a code for this userId.
 * userId format: "telegram:123456" or "discord:789" or raw string.
 * Returns: { code: "u007", userId, firstSeen }
 */
function getOrCreateCode(userId) {
  const reg = load();
  if (!reg.codes[userId]) {
    reg.counter = (reg.counter || 0) + 1;
    reg.codes[userId] = {
      code:      `u${String(reg.counter).padStart(3, "0")}`,
      userId,
      firstSeen: Date.now(),
    };
    save();
  }
  return reg.codes[userId];
}

function getCode(userId) {
  const reg = load();
  return reg.codes[userId] || null;
}

function allCodes() {
  return load().codes;
}

module.exports = { getOrCreateCode, getCode, allCodes };
