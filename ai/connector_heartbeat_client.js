"use strict";

const axios = require("axios");

const BASE_URL = String(process.env.INTERNAL_API_URL || "http://127.0.0.1:4050").replace(/\/$/, "");
const TOKEN = process.env.MEMORY_SERVICE_TOKEN || "";

function getHeaders() {
  return TOKEN ? { "x-memory-token": TOKEN } : {};
}

async function sendConnectorHeartbeat(connector, meta = {}) {
  if (!connector) return false;
  try {
    await axios.post(`${BASE_URL}/internal/connector/heartbeat`, {
      connector,
      meta,
      ts: Date.now(),
    }, {
      timeout: 3000,
      headers: getHeaders(),
    });
    return true;
  } catch {
    return false;
  }
}

function startConnectorHeartbeat(connector, metaFactory = null, intervalMs = 60000) {
  const tick = () => sendConnectorHeartbeat(connector, typeof metaFactory === "function" ? metaFactory() : {});
  tick().catch?.(() => {});
  return setInterval(() => {
    tick().catch?.(() => {});
  }, intervalMs);
}

module.exports = { sendConnectorHeartbeat, startConnectorHeartbeat };
