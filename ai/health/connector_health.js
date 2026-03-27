"use strict";

const fs = require("fs");
const path = require("path");
const { appendEvent } = require("../system_event_log");

const STORE_PATH = path.join(__dirname, "../../memory/connector_health.json");
const SILENT_MS = Number(process.env.CONNECTOR_SILENT_MS || 5 * 60 * 1000);

const state = { connectors: {} };
let loaded = false;

function loadState() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
      if (parsed && parsed.connectors) state.connectors = parsed.connectors;
    }
  } catch { /* ignore */ }
}

function persistState() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch { /* ignore */ }
}

function recordHeartbeat(connector, meta = {}) {
  loadState();
  if (!connector) return;
  const now = Date.now();
  const prev = state.connectors[connector] || {};
  state.connectors[connector] = {
    connector,
    lastHeartbeatAt: now,
    lastHeartbeatIso: new Date(now).toISOString(),
    meta,
    alertOpen: prev.alertOpen || false,
    alertedAt: prev.alertedAt || null,
  };
  persistState();
}

function getConnectorHealth(now = Date.now()) {
  loadState();
  const items = Object.values(state.connectors).map((c) => {
    const silentMs = Math.max(now - Number(c.lastHeartbeatAt || 0), 0);
    const level = silentMs > SILENT_MS ? "red" : (silentMs > SILENT_MS * 0.5 ? "yellow" : "green");
    return { ...c, silentMs, level };
  });
  return {
    silentThresholdMs: SILENT_MS,
    connectors: items.sort((a, b) => (b.lastHeartbeatAt || 0) - (a.lastHeartbeatAt || 0)),
  };
}

function checkSilentConnectors(now = Date.now()) {
  loadState();
  const alerts = [];

  for (const [name, item] of Object.entries(state.connectors)) {
    const silentMs = now - Number(item.lastHeartbeatAt || 0);
    if (silentMs > SILENT_MS) {
      if (!item.alertOpen) {
        item.alertOpen = true;
        item.alertedAt = now;
        appendEvent(
          "connector_silent",
          `connector silent: ${name}`,
          `${name} µL¤ß¸õ ${Math.round(silentMs / 1000)} ¬í`,
        );
      }
      alerts.push({ connector: name, silentMs, level: "red" });
    } else if (item.alertOpen) {
      item.alertOpen = false;
      item.alertedAt = null;
      appendEvent("connector_recovered", `connector recovered: ${name}`, `${name} ¤ß¸õ«ì´_`);
    }
  }

  persistState();
  return alerts;
}

module.exports = {
  recordHeartbeat,
  getConnectorHealth,
  checkSilentConnectors,
};
