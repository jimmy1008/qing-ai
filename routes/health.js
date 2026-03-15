"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const { getLLMHealth } = require("../ai/health/llm_health");
const { getConnectorHealth } = require("../ai/health/connector_health");

const OUTBOX_PATH = path.join(__dirname, "../memory/proactive_outbox.jsonl");

const router = express.Router();

router.get("/health/llm", async (_req, res) => {
  try {
    const health = await getLLMHealth();
    res.json({ ok: true, ...health });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/health/connectors", (_req, res) => {
  res.json({ ok: true, ...getConnectorHealth() });
});

router.get("/api/proactive/outbox", (_req, res) => {
  try {
    if (!fs.existsSync(OUTBOX_PATH)) return res.json({ items: [] });
    const items = fs.readFileSync(OUTBOX_PATH, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .slice(-200)
      .reverse();
    return res.json({ items });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
