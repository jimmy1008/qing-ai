const express = require("express");
const { requireAuth, requireSuperAdmin } = require("../auth/auth_middleware");
const { listTopRelationships, getIdentityTruth, addSharedMemory, removeSharedMemory } = require("../ai/memory_store");

const router = express.Router();

router.get("/api/relationships", requireAuth, requireSuperAdmin, (_req, res) => {
  const users = listTopRelationships(30).map(u => {
    const truth = getIdentityTruth(u.userId);
    return {
      userId: u.userId, nickname: u.nickname, familiarityScore: u.familiarityScore,
      interactionCount: u.interactionCount, lastInteractionAt: u.lastInteractionAt,
      role: truth.relationship.bondType === "primary" ? "developer" : truth.role || "public_user",
      sharedMemories: truth.relationship.sharedMemories || [],
    };
  });
  res.json({ users });
});

router.get("/api/relationships/:globalUserKey", requireAuth, requireSuperAdmin, (req, res) => {
  try { res.json(getIdentityTruth(req.params.globalUserKey)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/api/relationships/:globalUserKey/memories", requireAuth, requireSuperAdmin, (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "text required" });
  addSharedMemory(req.params.globalUserKey, String(text).trim(), "manual");
  res.json({ ok: true });
});

router.delete("/api/relationships/:globalUserKey/memories/:index", requireAuth, requireSuperAdmin, (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isFinite(index)) return res.status(400).json({ error: "invalid index" });
  removeSharedMemory(req.params.globalUserKey, index);
  res.json({ ok: true });
});

module.exports = router;
