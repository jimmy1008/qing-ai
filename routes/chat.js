const express = require("express");
const fs = require("fs");
const path = require("path");
const { buildContext, generateAIReply } = require("../ai/pipeline");
const { getCurrentMood, getRecentMoodEvents } = require("../ai/mood_engine");
const { consolidateEpisodes } = require("../ai/episodic_store");

module.exports = function createChatRouter({ ollamaClient }) {
  const router = express.Router();

  router.post("/api/chat", async (req, res) => {
    const userInput = req.body?.message || req.body?.text;
    if (!userInput || typeof userInput !== "string") return res.status(400).json({ error: "message is required" });
    try {
      const event = req.body?.event || {
        type: req.body?.eventType || "message", content: userInput, text: userInput,
        userId: req.body?.user_id || req.body?.userId || null, username: req.body?.username || null,
        connector: req.body?.connector || "api", isPrivate: Boolean(req.body?.isPrivate),
        channel: req.body?.channel || (req.body?.isPrivate ? "private" : "public"),
      };
      const history = Array.isArray(req.body?.history) ? req.body.history : [];
      const context = buildContext(userInput, history, {
        event, userId: req.body?.user_id || req.body?.userId || null,
        username: req.body?.username || null, role: req.body?.role || "user",
      });
      const result = await generateAIReply(userInput, context, ollamaClient);
      res.json({ reply: result.reply, skipped: Boolean(result.skipped), telemetry: result.telemetry });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get("/api/emotion-log", (_req, res) => {
    const moodState = getCurrentMood("Asia/Taipei");
    const recentEvents = getRecentMoodEvents(20);
    const residueDir = path.join(__dirname, "..", "memory", "emotional_residue");
    const perUserResidue = [];
    if (fs.existsSync(residueDir)) {
      for (const file of fs.readdirSync(residueDir).filter(f => f.endsWith(".json"))) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(residueDir, file), "utf-8"));
          const events = data.recentEmotionalEvents || [];
          const strongest = events.reduce((max, e) => (e.intensity || 0) > (max.intensity || 0) ? e : max, { intensity: 0, type: "none" });
          perUserResidue.push({
            userKey: file.replace(".json", ""), baselineMood: data.baselineMood || "CALM",
            moodDrift: Number((data.moodDrift || 0).toFixed(3)), eventCount: events.length,
            strongestType: strongest.type, strongestIntensity: Number((strongest.intensity || 0).toFixed(3)),
          });
        } catch { /* skip */ }
      }
    }
    perUserResidue.sort((a, b) => b.moodDrift - a.moodDrift);
    res.json({ moodState, recentEvents, perUserResidue });
  });

  router.post("/api/memory/consolidate", (_req, res) => {
    const episodesDir = path.join(__dirname, "..", "memory", "episodes");
    const results = [];
    if (fs.existsSync(episodesDir)) {
      for (const file of fs.readdirSync(episodesDir).filter(f => f.endsWith(".jsonl"))) {
        const userKey = file.replace(".jsonl", "");
        try { results.push({ userKey, ...consolidateEpisodes(userKey) }); }
        catch (err) { results.push({ userKey, error: err.message }); }
      }
    }
    res.json({ ok: true, results });
  });

  return router;
};
