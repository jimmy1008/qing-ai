"use strict";

const express = require("express");
const { appendLineSerialized, validateInternalToken } = require("../ai/memory_service");
const { storeEpisode, saveEpisodes } = require("../ai/episodic_store");

const router = express.Router();

router.use("/internal", (req, res, next) => {
  if (!validateInternalToken(req)) {
    return res.status(403).json({ error: "invalid memory service token" });
  }
  next();
});

router.post("/internal/memory/write", async (req, res) => {
  const filePath = String(req.body?.filePath || "").trim();
  const line = req.body?.line;
  if (!filePath) {
    return res.status(400).json({ error: "filePath is required" });
  }

  try {
    await appendLineSerialized(filePath, line);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/internal/memory/episode/store", async (req, res) => {
  const globalUserKey = String(req.body?.globalUserKey || "").trim();
  if (!globalUserKey) {
    return res.status(400).json({ error: "globalUserKey is required" });
  }

  try {
    const episode = await storeEpisode(globalUserKey, {
      event_type: req.body?.event_type,
      summary: req.body?.summary,
      importance: req.body?.importance,
      embedding: req.body?.embedding,
      emotional_tag: req.body?.emotional_tag,
    }, { localOnly: true });

    return res.json({ ok: true, episode });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/internal/memory/episode/save", async (req, res) => {
  const globalUserKey = String(req.body?.globalUserKey || "").trim();
  const episodes = Array.isArray(req.body?.episodes) ? req.body.episodes : null;
  if (!globalUserKey || !episodes) {
    return res.status(400).json({ error: "globalUserKey and episodes are required" });
  }

  try {
    saveEpisodes(globalUserKey, episodes, { localOnly: true });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
