"use strict";
// Session-based working memory for recent conversation turns.
// Keyed by platform:channel:entityId — separate per scene.
// Group chats share one session (by chatId); private chats are per-user.
//
// Persistence: each session is written to memory/working/{key}.json
// so that conversation history survives process restarts.
// Sessions older than STALE_HOURS hours are discarded on load.

const fs   = require("fs");
const path = require("path");

const MAX_TURNS   = 20;        // 20 pairs = 40 messages max
const STALE_HOURS = 12;        // Discard sessions with no activity in the last 12 hours

const WORKING_DIR = path.join(__dirname, "../../memory/working");

const sessions      = new Map();   // key → [{role, text, ts, ...}]
const _writeTimers  = new Map();   // debounce handles, one per session key
const _resumptions  = new Map();   // key → last 3 turn pairs, survives stale pruning

// ── Filename helpers ────────────────────────────────────────────────────────

function _keyToFile(key) {
  const safe = String(key).replace(/:/g, "__").replace(/[/\\?%*|"<>]/g, "_");
  return path.join(WORKING_DIR, `${safe}.json`);
}

function _fileToKey(filename) {
  return filename.replace(/\.json$/, "").replace(/__/g, ":");
}

// ── Startup load ────────────────────────────────────────────────────────────

function _loadAll() {
  if (!fs.existsSync(WORKING_DIR)) return;
  const cutoff = Date.now() - STALE_HOURS * 60 * 60 * 1000;
  let loaded = 0;
  let pruned = 0;

  let files;
  try { files = fs.readdirSync(WORKING_DIR).filter(f => f.endsWith(".json")); }
  catch { return; }

  for (const filename of files) {
    const key = _fileToKey(filename);
    try {
      const raw = fs.readFileSync(path.join(WORKING_DIR, filename), "utf-8").trim();
      if (!raw) continue;
      const turns = JSON.parse(raw);
      if (!Array.isArray(turns) || turns.length === 0) continue;

      // Check staleness by last message timestamp
      const lastTs = turns[turns.length - 1]?.ts || 0;
      if (lastTs < cutoff) {
        // Stale — extract last 3 pairs as resumption context before pruning
        const pairs = [];
        for (let i = turns.length - 1; i >= 0 && pairs.length < 6; i--) {
          pairs.unshift(turns[i]);
        }
        if (pairs.length > 0) _resumptions.set(key, pairs);
        try { fs.unlinkSync(path.join(WORKING_DIR, filename)); } catch { /* ignore */ }
        pruned++;
        continue;
      }

      sessions.set(key, turns);
      loaded++;
    } catch {
      /* skip corrupted file */
    }
  }

  if (loaded + pruned > 0) {
    console.log(`[working_memory] loaded ${loaded} sessions, pruned ${pruned} stale`);
  }
}

_loadAll();

// ── Disk write (debounced per session) ──────────────────────────────────────

function _persist(key) {
  if (_writeTimers.has(key)) return;
  _writeTimers.set(key, setImmediate(() => {
    _writeTimers.delete(key);
    const turns = sessions.get(key);
    try {
      fs.mkdirSync(WORKING_DIR, { recursive: true });
      if (turns && turns.length > 0) {
        fs.writeFileSync(_keyToFile(key), JSON.stringify(turns), "utf-8");
      } else {
        // Session cleared — remove file
        try { fs.unlinkSync(_keyToFile(key)); } catch { /* already gone */ }
      }
    } catch (err) {
      console.warn(`[working_memory] persist error for "${key}":`, err.message);
    }
  }));
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Generate a session key from a raw event.
 */
function makeSessionKey(event) {
  const platform = event.platform || event.connector || "unknown";
  const isPrivate = Boolean(event.isPrivate || event.channel === "private");
  const channel = isPrivate ? "private" : (event.channel || "group");
  const entityId = (!isPrivate)
    ? (event.chatId || event.groupId || event.channel_id || "default_group")
    : (String(event.userId || event.speaker_id || "anon"));
  return `${platform}:${channel}:${entityId}`;
}

/**
 * Returns the session array for a given key (creates if missing).
 */
function getSession(key) {
  if (!sessions.has(key)) sessions.set(key, []);
  return sessions.get(key);
}

/**
 * Appends a user+AI turn to the session and schedules a disk write.
 */
function addTurn(key, speakerId, speakerName, userText, aiText) {
  const session = getSession(key);
  const ts = Date.now();
  session.push({ role: "user",      speaker_id: speakerId, speaker_name: speakerName, text: userText,  ts });
  session.push({ role: "assistant", speaker_id: "ai",       speaker_name: "晴",        text: aiText,   ts });
  // Trim oldest pairs when over limit
  while (session.length > MAX_TURNS * 2) session.splice(0, 2);
  _persist(key);
}

/**
 * Clear a session and remove its file.
 */
function clearSession(key) {
  sessions.delete(key);
  _persist(key);
}

/**
 * Stats for monitoring.
 */
function getStats() {
  return {
    activeSessions: sessions.size,
    totalMessages: [...sessions.values()].reduce((a, s) => a + s.length, 0),
  };
}

/**
 * Returns the last 3 turn-pairs (up to 6 messages) from a previously stale session.
 * Used by context_builder to give the AI a memory anchor at conversation restart.
 * Returns [] if no resumption context exists for this key.
 *
 * @param {string} key  — session key from makeSessionKey()
 */
function getResumptionContext(key) {
  return _resumptions.get(key) || [];
}

module.exports = { makeSessionKey, getSession, addTurn, clearSession, getStats, getResumptionContext };
