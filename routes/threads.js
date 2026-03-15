const express = require("express");
const { requireAuth, requireSuperAdmin } = require("../auth/auth_middleware");
const {
  listQueue, getQueueItem, editQueueItem, regenerateQueueItem,
  approveQueueItem, rejectQueueItem, getQueueStats, enqueueModeration,
} = require("../ai/moderation_queue");
const {
  executeAction: executeThreadsAction,
  runSmoke: runThreadsSmoke,
  runAutonomousSession,
  THREADS_MAX_ACTIONS_PER_SESSION,
  THREADS_SESSION_DURATION_LIMIT,
} = require("../connectors/threads_browser/executor");
const { runNotificationScan } = require("../connectors/threads_browser/notification_scanner");
const { getThreadsContext } = require("../connectors/threads_browser/browser_manager");
const { scanFeed } = require("../connectors/threads_browser/feed_scanner");
const { handleIncomingThreadComment } = require("../connectors/threads_browser/comment_listener");
const { recordSelfPost, readSelfPosts } = require("../connectors/threads_browser/self_posts_store");
const {
  planAction, buildThreadsPublicReply, shouldEngageExternalPost, canReplyExternal, processNextAction,
} = require("../ai/action_planner");
const { processEvent: orchestratorV2 } = require("../ai/orchestrator");
const { getCurrentMood, getMoodReadDelay } = require("../ai/mood_engine");

// Threads public reply via v2 orchestrator
async function generateThreadsPublicReplyFromLLM(event = {}) {
  const text = event.content || event.text || event.postText || "";
  const orchEvent = {
    type:      "message",
    text,
    content:   text,
    userId:    event.userId || null,
    username:  event.authorUsername || event.username || null,
    connector: "threads_browser",
    isPrivate: false,
    channel:   "public",
    role:      "public_user",
    meta: {
      originalPost:    event.originalPost || null,
      originalComment: event.originalComment || null,
      targetUrl:       event.targetUrl || null,
      regenerateIndex: event.regenerateIndex || 0,
      previousReply:   event.previousReply || null,
    },
  };
  const result = await orchestratorV2(orchEvent);
  return {
    replyText:   String(result?.reply || ""),
    toneProfile: result?.meta?.tone || "natural",
    personaModeKey: "public_user_public",
  };
}

const MAX_AUTO_SCAN_PER_HOUR = 2;
const autoScanTimestamps = [];

function pruneAutoScanTimestamps(now = Date.now()) {
  while (autoScanTimestamps.length && now - autoScanTimestamps[0] > 3600000) {
    autoScanTimestamps.shift();
  }
}

function canRunThreadsAutoScan(now = Date.now()) {
  pruneAutoScanTimestamps(now);
  return autoScanTimestamps.length < MAX_AUTO_SCAN_PER_HOUR;
}

function detectThreadsLoginIssue(debug) {
  const preview = String(debug?.bodyTextPreview || "");
  const patterns = [/log in/i, /sign in/i, /continue with instagram/i, /\u767b\u5165/, /\u767b\u5165\u6216\u8a3b\u518a/];
  return patterns.some(p => p.test(preview));
}

const router = express.Router();

router.get("/api/threads-activity", requireAuth, requireSuperAdmin, (_req, res) => {
  const actionLogPath = require("path").join(__dirname, "../logs/actions.log");
  const fs = require("fs");
  function tailFile(fp, n) {
    if (!fs.existsSync(fp)) return "";
    const data = fs.readFileSync(fp, "utf-8");
    return data.split("\n").filter(Boolean).slice(-n).join("\n");
  }
  const lines = tailFile(actionLogPath, 300).split("\n").filter(Boolean);
  const threadsEntries = lines
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(e => e && e.kind === "threads_activity");
  const lastSession = threadsEntries.filter(e => e.stage === "threads_session_end").slice(-1)[0] || null;
  const lastSessionStart = threadsEntries.filter(e => e.stage === "threads_session_start").slice(-1)[0] || null;
  const lastLike = threadsEntries.filter(e => e.stage === "threads_like").slice(-1)[0] || null;
  const lastReply = threadsEntries.filter(e => e.stage === "threads_reply").slice(-1)[0] || null;
  const lastCommentQueued = threadsEntries.filter(e => e.stage === "threads_comment_queued").slice(-1)[0] || null;
  const recentLikes = threadsEntries.filter(e => e.stage === "threads_like").slice(-5);
  const commentProposalCount = threadsEntries.filter(e => e.stage === "threads_comment_queued").length;
  const queueStats = getQueueStats();
  res.json({ lastSession, lastSessionStart, lastLike, lastReply, lastCommentQueued, recentLikes, commentProposalCount, pending: queueStats.pending, approved: queueStats.approved });
});

router.get("/api/threads-impressions", requireAuth, requireSuperAdmin, (_req, res) => {
  try {
    const { getTopAuthors, getTotalTracked } = require("../ai/threads_impression_store");
    res.json({ topAuthors: getTopAuthors(10), totalTracked: getTotalTracked(), lastUpdatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/threads-smoke", requireAuth, requireSuperAdmin, async (_req, res) => {
  try {
    const result = await runThreadsSmoke();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/api/threads-self-posts", requireAuth, requireSuperAdmin, (_req, res) => {
  res.json({ items: readSelfPosts() });
});

router.post("/api/threads-self-posts", requireAuth, requireSuperAdmin, (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const postId = String(req.body?.postId || "").trim();
  if (!postId) return res.status(400).json({ error: "postId required" });
  const saved = recordSelfPost(postId, { source: "manual" });
  return res.json({ success: true, item: saved });
});

router.get("/api/threads/external-rate-status", requireAuth, (_req, res) => {
  const status = canReplyExternal();
  res.json({
    hourCount: status.hourCount, hourLimit: status.limits.hour,
    dayCount: status.dayCount, dayLimit: status.limits.day,
    hourRemaining: Math.max(status.limits.hour - status.hourCount, 0),
    dayRemaining: Math.max(status.limits.day - status.dayCount, 0),
    limitReached: !status.allowed,
  });
});

router.post("/api/threads-comment-test", requireAuth, requireSuperAdmin, async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const comment = req.body?.comment || req.body || {};
  const autoRegisterSelfPost = Boolean(req.body?.registerSelfPost);
  const skipCooldown = req.body?.skipCooldown !== false;
  if (autoRegisterSelfPost && comment?.postId) {
    recordSelfPost(comment.postId, { source: "test" });
  }
  const emitted = handleIncomingThreadComment(comment, { skipCooldown });
  let processed = null;
  if (emitted?.emitted) processed = await processNextAction();
  return res.json({ success: true, emitted, processed, queue: getQueueStats() });
});

router.post("/api/threads-autonomous", requireAuth, requireSuperAdmin, async (_req, res) => {
  try {
    const result = await runAutonomousSession();
    res.json({
      success: true,
      limits: { maxActionsPerSession: THREADS_MAX_ACTIONS_PER_SESSION, preferenceThreshold: "dynamic(0.60-0.80)", sessionDurationLimitMs: THREADS_SESSION_DURATION_LIMIT },
      result,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/api/threads-auto-scan", requireAuth, requireSuperAdmin, async (_req, res) => {
  const now = Date.now();
  if (!canRunThreadsAutoScan(now)) {
    return res.status(429).json({ success: false, error: "threads auto scan hourly limit reached", limit: MAX_AUTO_SCAN_PER_HOUR });
  }
  try {
    const context = await getThreadsContext();
    const page = context.pages()[0] || await context.newPage();
    await page.goto("https://www.threads.net/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(1000);
    }
    const { posts, debug } = await scanFeed(page, 8);
    const proposals = [];
    const moodState = getCurrentMood("Asia/Taipei");
    if (detectThreadsLoginIssue(debug)) debug.note = "Likely not logged in / checkpoint";
    for (const post of posts) {
      await page.waitForTimeout(getMoodReadDelay(moodState.mood));
      const externalEvent = {
        type: "NEW_POST_IN_FEED", platform: "threads", connector: "threads_browser",
        channel: "public", interactionSource: "ai_initiated", personaModeKey: "public_user_public",
        username: post.authorUsername || null, authorUsername: post.authorUsername || null,
        targetUrl: post.url || null, postId: post.id, postText: post.text, content: post.text,
        originalPost: { postId: post.id, authorUsername: post.authorUsername || null, content: post.text, url: post.url || null },
        originalComment: null,
        platformUserRef: post.authorUsername ? { platform: "threads", userId: null, username: post.authorUsername } : null,
      };
      if (shouldEngageExternalPost(externalEvent) && proposals.length < 2) {
        let publicReply;
        try { publicReply = await generateThreadsPublicReplyFromLLM(externalEvent); }
        catch { publicReply = buildThreadsPublicReply(externalEvent); }
        const proposal = planAction("reply", {
          platform: "threads", connector: "threads_browser", postId: post.id,
          targetUrl: post.url || null, proposalType: "reply_external_post",
          content: publicReply.replyText, type: "NEW_POST_IN_FEED",
          userId: null, originalPost: externalEvent.originalPost, originalComment: null,
        });
        enqueueModeration(proposal, { ...externalEvent, toneStyle: publicReply.toneProfile }, { allowed: false, reason: "proposal_only" });
        proposals.push(proposal);
      }
    }
    autoScanTimestamps.push(now);
    res.json({ success: true, scanned: posts.length, evaluated: posts.length, proposals: proposals.length, limit: MAX_AUTO_SCAN_PER_HOUR, mood: moodState, debug });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/api/threads/backfill", requireAuth, requireSuperAdmin, async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const lookbackMinutes = Number(req.body?.lookbackMinutes || 60);
  try {
    const { backfillRecentComments } = require("../connectors/threads_browser/backfill");
    const result = await backfillRecentComments(lookbackMinutes);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/api/threads/scan-notifications", requireAuth, requireSuperAdmin, async (_req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    const result = await runNotificationScan();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/api/threads-moderation", requireAuth, (req, res) => {
  const status = req.query?.status || "pending";
  const sortBy = req.query?.sortBy || "createdAt";
  const rank = { L0: 0, L1: 1, L2: 2, L3: 3 };
  const items = listQueue(status).sort((a, b) => {
    if (sortBy === "riskLevel") return (rank[b.riskLevel] ?? 99) - (rank[a.riskLevel] ?? 99);
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  res.json({ items, stats: getQueueStats() });
});

router.patch("/api/threads-moderation/:id", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const item = editQueueItem(req.params.id, req.body?.editedContent);
  if (!item) return res.status(404).json({ error: "queue item not found" });
  res.json(item);
});

router.post("/api/threads-moderation/:id/regenerate", requireAuth, async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const item = getQueueItem(req.params.id);
  if (!item) return res.status(404).json({ error: "queue item not found" });
  if (item.status !== "pending") return res.status(400).json({ error: "queue item is not pending" });
  const event = item.sourceEvent || null;
  if (!event || event.platform !== "threads") return res.status(400).json({ error: "source event unavailable for regeneration" });
  try {
    const nextRegenerateIndex = Number(event.regenerateIndex || 0) + 1;
    const regenerated = await generateThreadsPublicReplyFromLLM({ ...event, regenerateIndex: nextRegenerateIndex, previousReply: item.content || "" });
    const updated = regenerateQueueItem(item.id, {
      content: regenerated.replyText, toneProfile: regenerated.toneProfile, personaMode: regenerated.personaModeKey,
      sourceEvent: { ...event, regenerateIndex: nextRegenerateIndex, personaModeKey: regenerated.personaModeKey, toneStyle: regenerated.toneProfile },
    });
    if (!updated) return res.status(500).json({ error: "failed to regenerate proposal" });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message || "failed to regenerate proposal" });
  }
});

router.post("/api/threads-moderation/:id/approve", requireAuth, async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const item = getQueueItem(req.params.id);
  if (!item) return res.status(404).json({ error: "queue item not found" });
  if (item.status !== "pending") return res.status(400).json({ error: "queue item is not pending" });
  try {
    const execution = await executeThreadsAction({
      platform: item.platform, action: item.type, targetPostId: item.targetPostId,
      targetUrl: item.targetUrl, content: item.editedContent || item.content || "",
    });
    if (execution?.success && execution?.newPostId) {
      recordSelfPost(execution.newPostId, { source: "auto", url: execution.newPostUrl || null });
    }
    const updated = approveQueueItem(item.id, req.body?.approvedBy || null, execution);
    res.json(updated);
  } catch (err) {
    const updated = approveQueueItem(item.id, req.body?.approvedBy || null, { success: false, error: err.message });
    res.status(500).json(updated);
  }
});

router.post("/api/threads-moderation/:id/reject", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const updated = rejectQueueItem(req.params.id, req.body?.rejectedBy || null, req.body?.reason || "");
  if (!updated) return res.status(404).json({ error: "queue item not found" });
  res.json(updated);
});

module.exports = router;
