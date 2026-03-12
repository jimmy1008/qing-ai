const express = require("express");
const path = require("path");
const DASH = path.join(__dirname, "..", "dashboard");

const router = express.Router();

router.get("/threads-moderation", (_req, res) => res.sendFile(path.join(DASH, "threads-moderation.html")));
router.get("/ai-cognition",       (_req, res) => res.sendFile(path.join(DASH, "ai-cognition.html")));
router.get("/relationships",      (_req, res) => res.sendFile(path.join(DASH, "relationships.html")));
router.get("/ai-thoughts",        (_req, res) => res.redirect(301, "/ai-cognition"));
router.get("/voice-chat",         (_req, res) => res.sendFile(path.join(DASH, "voice.html")));
router.get("/emotion-log",        (_req, res) => res.sendFile(path.join(DASH, "emotion-log.html")));

module.exports = router;
