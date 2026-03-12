const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(
  __dirname,
  "..",
  "memory",
  "processed_threads_comments.json"
);

// In-memory Set — loaded once at startup, persisted on every markProcessed().
// Prevents duplicate backfill processing across restarts.
let _processedSet = null;

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function getSet() {
  if (_processedSet === null) {
    const raw = loadStore();
    _processedSet = new Set(Object.keys(raw));
    console.log(`[BACKFILL] Loaded ${_processedSet.size} processed comment IDs from disk`);
  }
  return _processedSet;
}

function isProcessed(commentId) {
  return getSet().has(String(commentId));
}

function markProcessed(commentId) {
  const id = String(commentId);
  const set = getSet();
  if (set.has(id)) return;
  set.add(id);

  // Persist as { id: true } object (consistent with loadStore format)
  const obj = {};
  for (const k of set) obj[k] = true;
  fs.writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2), "utf8");
}

module.exports = {
  isProcessed,
  markProcessed,
};
