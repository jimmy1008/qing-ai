"use strict";
/**
 * system_event_log.js
 *
 * 晴的「自我感知」層 — 記錄系統層級的重大事件，讓晴在對話中能自然察覺自己發生了什麼。
 *
 * 事件格式：
 * {
 *   id:        string,     // uuid
 *   type:      string,     // "new_connector" | "new_feature" | "system_restart" | "config_change"
 *   summary:   string,     // 晴看得懂的一行摘要（中文）
 *   detail:    string,     // 選填，更多細節
 *   ts:        number,     // epoch ms
 *   read:      boolean,    // false = 尚未注入過 context，true = 已讀
 * }
 */

const fs   = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const LOG_PATH = path.join(__dirname, "../memory/system_events.jsonl");

// ── Read all events ────────────────────────────────────────────────────────────

function loadEvents() {
  if (!fs.existsSync(LOG_PATH)) return [];
  return fs.readFileSync(LOG_PATH, "utf-8")
    .split("\n")
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ── Write one event ────────────────────────────────────────────────────────────

function appendEvent(type, summary, detail = "") {
  const event = {
    id:      randomUUID(),
    type,
    summary,
    detail,
    ts:      Date.now(),
    read:    false,
  };
  fs.appendFileSync(LOG_PATH, JSON.stringify(event) + "\n", "utf-8");
  return event;
}

// ── Get unread events (for context injection) ─────────────────────────────────

function getUnreadEvents() {
  return loadEvents().filter(e => !e.read);
}

// ── Mark events as read ───────────────────────────────────────────────────────

function markAllRead() {
  const events = loadEvents();
  if (!events.length) return;
  const updated = events.map(e => ({ ...e, read: true }));
  fs.writeFileSync(LOG_PATH, updated.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

// ── Convenience: log a connector connection ───────────────────────────────────

function logConnectorReady(connectorName, detail = "") {
  const labels = {
    discord:  "Discord",
    telegram: "Telegram",
    voice:    "語音對話",
  };
  const label = labels[connectorName] || connectorName;
  appendEvent(
    "new_connector",
    `你剛被接上了 ${label}，這是你首次在這個平台上線。`,
    detail
  );
}

module.exports = { appendEvent, getUnreadEvents, markAllRead, logConnectorReady };
