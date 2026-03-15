const fs   = require("fs");
const path = require("path");

// ── Paths ──────────────────────────────────────────────────────────────────
const MEMORY_DIR      = path.join(__dirname, "users");
const LEGACY_PATH     = path.join(__dirname, "memory.json");

// ── Filename helpers ────────────────────────────────────────────────────────
/**
 * Convert a memoryMap key into a safe filename.
 * e.g.  "identity:global_12345"  →  "identity__global_12345.json"
 *       "user:global_abc"        →  "user__global_abc.json"
 *       "group:1234567890"       →  "group__1234567890.json"
 */
function keyToFilename(key) {
  // Replace colons and any path-unsafe chars with double-underscore
  const safe = String(key).replace(/:/g, "__").replace(/[/\\?%*|"<>]/g, "_");
  return `${safe}.json`;
}

function filenameToKey(filename) {
  // Reverse: "__" back to ":"
  return filename.replace(/\.json$/, "").replace(/__/g, ":");
}

function userFilePath(key) {
  return path.join(MEMORY_DIR, keyToFilename(key));
}

// ── Migration from legacy single-file ─────────────────────────────────────
function _migrateLegacy() {
  if (!fs.existsSync(LEGACY_PATH)) return;
  try {
    const raw = fs.readFileSync(LEGACY_PATH, "utf-8").trim();
    if (!raw) return;
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length === 0) return;

    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    let migrated = 0;
    for (const [key, value] of entries) {
      const fp = userFilePath(key);
      if (!fs.existsSync(fp)) {
        fs.writeFileSync(fp, JSON.stringify(value, null, 2), "utf-8");
        migrated++;
      }
    }
    // Rename legacy file so we don't migrate again
    fs.renameSync(LEGACY_PATH, LEGACY_PATH + ".migrated");
    console.log(`[memory] migrated ${migrated} entries from memory.json → memory/users/`);
  } catch (err) {
    console.warn("[memory] legacy migration failed:", err.message);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Save all entries in memoryMap to individual per-user files.
 * Called via persistMemory() debounce in memory_store.js.
 */
function save(memoryMap) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  for (const [key, value] of memoryMap.entries()) {
    try {
      fs.writeFileSync(userFilePath(key), JSON.stringify(value, null, 2), "utf-8");
    } catch (err) {
      console.warn(`[memory] save failed for key "${key}":`, err.message);
    }
  }
}

/**
 * Save a single key — more efficient for targeted writes.
 */
function saveKey(key, value) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  try {
    fs.writeFileSync(userFilePath(key), JSON.stringify(value, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[memory] saveKey failed for "${key}":`, err.message);
  }
}

/**
 * Load all per-user files into a Map.
 * Also runs one-time migration from the legacy memory.json.
 */
/**
 * Startup: only run migration, do NOT load all files into memory.
 * memory_store.js already has lazy loading per-key via loadKey().
 * This keeps startup memory O(1) regardless of user count.
 */
function load() {
  _migrateLegacy();
  return new Map(); // empty — lazy loading fills it on first access
}

/**
 * Load a single key from disk (for lazy loading in memory_store).
 * Returns the parsed object, or null if the file doesn't exist.
 */
function loadKey(key) {
  const fp = userFilePath(key);
  if (!fs.existsSync(fp)) return null;
  try {
    const raw = fs.readFileSync(fp, "utf-8").trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

module.exports = { save, saveKey, loadKey, load, MEMORY_DIR, LEGACY_PATH };
