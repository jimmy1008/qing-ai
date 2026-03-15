"use strict";

const express = require("express");
const { validateInternalToken } = require("../ai/memory_service");
const { recordHeartbeat } = require("../ai/health/connector_health");

const router = express.Router();

router.use("/internal", (req, res, next) => {
  if (!validateInternalToken(req)) {
    return res.status(403).json({ error: "invalid internal token" });
  }
  next();
});

router.post("/internal/connector/heartbeat", (req, res) => {
  const connector = String(req.body?.connector || "").trim();
  if (!connector) return res.status(400).json({ error: "connector is required" });

  recordHeartbeat(connector, {
    ...req.body?.meta,
    sourceIp: req.ip,
    ts: req.body?.ts || Date.now(),
  });

  return res.json({ ok: true });
});

module.exports = router;
