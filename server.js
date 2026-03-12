const path = require("path");
const dotenv = require("dotenv");
const WebSocket = require("ws");
const axios = require("axios");

dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config({ path: path.join(__dirname, ".env.local"), override: true });

const express = require("express");
const fs = require("fs");
const { requireAuth, requireSuperAdmin } = require("./auth/auth_middleware");
const {
  buildContext,
  createOllamaClient,
  generateAIReply,
  generateVoiceReplyStream,
  generateThreadsPublicReplyFromLLM,
} = require("./ai/pipeline");
const { getConnectorMetrics } = require("./metrics/connector_metrics");
const { getEventMetrics } = require("./metrics/event_metrics");
const { getActionMetrics } = require("./metrics/action_metrics");
const { getReflexMetrics } = require("./metrics/reflex_metrics");
const { getConversationMetrics } = require("./metrics/conversation_metrics");
const { getMemoryMetrics } = require("./metrics/memory_metrics");
const stabilityWindow = require("./metrics/stability_window");
const { evaluateAlerts } = require("./metrics/alert_rules");
const historyBuffer = require("./metrics/history_buffer");
const {
  listQueue,
  getQueueItem,
  editQueueItem,
  regenerateQueueItem,
  approveQueueItem,
  rejectQueueItem,
  getQueueStats,
  enqueueModeration,
} = require("./ai/moderation_queue");
const {
  executeAction: executeThreadsAction,
  runSmoke: runThreadsSmoke,
  runAutonomousSession,
  THREADS_MAX_ACTIONS_PER_SESSION,
  THREADS_SESSION_DURATION_LIMIT,
} = require("./connectors/threads_browser/executor");
const { runNotificationScan } = require("./connectors/threads_browser/notification_scanner");
const { getThreadsContext } = require("./connectors/threads_browser/browser_manager");
const { scanFeed } = require("./connectors/threads_browser/feed_scanner");
const { handleIncomingThreadComment } = require("./connectors/threads_browser/comment_listener");
const {
  listTopRelationships,
  getIdentityTruth,
  addSharedMemory,
  removeSharedMemory,
} = require("./ai/memory_store");
const { recordSelfPost, readSelfPosts } = require("./connectors/threads_browser/self_posts_store");
const {
  planAction,
  planLikeProposal,
  buildThreadsPublicReply,
  shouldEngageExternalPost,
  canReplyExternal,
  processNextAction,
} = require("./ai/action_planner");
const { evaluateLikeScore } = require("./ai/like_evaluator");
const { getCurrentMood, getMoodReadDelay, getRecentMoodEvents } = require("./ai/mood_engine");
const { consolidateEpisodes } = require("./ai/episodic_store");
const { startActivityLoop } = require("./ai/threads_activity_scheduler");
const { getAISnapshot, getAIThoughtsSnapshot } = require("./ai/state_snapshot");

console.log("RUNNING FILE:", __filename);
console.log("=== MODEL CONFIG ===");
console.log("LLM_MODEL:", process.env.LLM_MODEL || "qwen2.5:14b (default)");
console.log("ADAPTER_DIR:", process.env.ADAPTER_DIR || "(not set)");
console.log("ADAPTER_VERSION:", process.env.ADAPTER_VERSION || "(not set)");
console.log("====================");

const app = express();
const PORT = 4050;
const startTime = Date.now();
const ollamaClient = createOllamaClient();
const connectorLogPath = path.join(__dirname, "logs/connector.log");
const actionLogPath = path.join(__dirname, "logs/actions.log");
const personaRegressionPath = path.join(__dirname, "train/persona_mode_regression_report.json");
const engageRegressionPath = path.join(__dirname, "train/engage_filter_regression_report.json");
const MAX_AUTO_SCAN_PER_HOUR = 2;
const autoScanTimestamps = [];

app.use(express.json());
app.use("/api", (_req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});
app.use(express.static(path.join(__dirname, "dashboard")));

app.get("/threads-moderation", (_req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "threads-moderation.html"));
});

app.get("/ai-cognition", (_req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "ai-cognition.html"));
});

app.get("/relationships", (_req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "relationships.html"));
});

app.get("/ai-thoughts", (_req, res) => {
  res.redirect(301, "/ai-cognition");
});

function tailFile(filePath, limit = 80) {
  if (!fs.existsSync(filePath)) return "";
  const data = fs.readFileSync(filePath, "utf-8");
  return data.split("\n").filter(Boolean).slice(-limit).join("\n");
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

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
  const patterns = [
    /log in/i,
    /sign in/i,
    /continue with instagram/i,
    /\u767b\u5165/,
    /\u767b\u5165\u6216\u8a3b\u518a/,
  ];
  return patterns.some((pattern) => pattern.test(preview));
}

function buildMetricsPayload() {
  const currentReflexMetrics = getReflexMetrics();
  const conversation = getConversationMetrics();
  const rolling = stabilityWindow.compute();
  historyBuffer.push(rolling);
  const history = historyBuffer.get();
  const alerts = evaluateAlerts(rolling);
  const healthScoreRaw = 100
    - ((rolling?.artifactRate || 0) * 100)
    - ((rolling?.reflexFailRate || 0) * 100)
    - ((rolling?.secondLineDriftRate || 0) * 50)
    - ((rolling?.reflexRetryRate || 0) * 20);
  const healthScore = Math.max(0, Math.min(100, Number(healthScoreRaw.toFixed(1))));
  const actions = getActionMetrics();
  const memory = getMemoryMetrics();
  const personaRegression = readJson(personaRegressionPath, null);
  const engageRegression = readJson(engageRegressionPath, null);

  return {
    connector: getConnectorMetrics(),
    events: getEventMetrics(),
    actions,
    memory,
    regressions: {
      persona: personaRegression,
      engage: engageRegression,
    },
    reflex: currentReflexMetrics,
    conversation,
    rolling,
    history,
    healthScore,
    alerts,
    risk: {
      high_risk_count: actions.L3,
      pending_review: actions.pending_review,
    },
    system: {
      uptime_sec: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    },
  };
}

function buildAnalysisSummary() {
  const metrics = buildMetricsPayload();
  return {
    actions: {
      pending_review: metrics.actions.pending_review,
      threads_pending: metrics.actions.threads_pending,
      engage_rate: metrics.actions.engage_rate,
      ignore_rate: metrics.actions.ignore_rate,
      top_ignore_reason: metrics.actions.top_ignore_reason,
      top_engage_reason: metrics.actions.top_engage_reason,
      persona_mode_dist: metrics.actions.persona_mode_dist,
      hostile_ignore_rate: metrics.actions.hostile_ignore_rate,
      low_signal_ignore_rate: metrics.actions.low_signal_ignore_rate,
    },
    regressions: metrics.regressions,
    queue: getQueueStats(),
    system: {
      timestamp: metrics.system.timestamp,
    },
  };
}

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ role: req.userRole });
});

app.get("/api/metrics", requireAuth, requireSuperAdmin, (_req, res) => {
  res.json(buildMetricsPayload());
});

app.get("/api/analysis-summary", requireAuth, (_req, res) => {
  res.json(buildAnalysisSummary());
});

app.get("/api/ai-cognition", requireAuth, requireSuperAdmin, (_req, res) => {
  res.json(getAISnapshot());
});

app.get("/api/ai-thoughts", requireAuth, requireSuperAdmin, (_req, res) => {
  res.json(getAIThoughtsSnapshot());
});

app.get("/api/system-health", requireAuth, requireSuperAdmin, (_req, res) => {
  const metrics = buildMetricsPayload();
  res.json({
    connector: metrics.connector,
    healthScore: metrics.healthScore,
    alerts: metrics.alerts,
    system: metrics.system,
    risk: metrics.risk,
  });
});

app.get("/api/full-audit", requireAuth, requireSuperAdmin, (_req, res) => {
  res.json(buildMetricsPayload());
});

app.get("/api/telemetry", requireAuth, requireSuperAdmin, (_req, res) => {
  const metrics = buildMetricsPayload();
  res.json({
    reflex: metrics.reflex,
    conversation: metrics.conversation,
    rolling: metrics.rolling,
    history: metrics.history,
    memory: metrics.memory,
  });
});

app.get("/api/action-metrics", requireAuth, requireSuperAdmin, (_req, res) => {
  res.json(getActionMetrics());
});

// ── Telemetry: structured action history ──────────────────────────────────────
app.get("/api/ai-actions", requireAuth, requireSuperAdmin, (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  const filterConnector = req.query.connector || null;
  const filterType = req.query.type || null;
  const from = req.query.from ? Number(req.query.from) : null;
  const to = req.query.to ? Number(req.query.to) : null;

  const lines = tailFile(actionLogPath, 1000).split("\n").filter(Boolean);
  let entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  if (filterConnector) entries = entries.filter((e) => e.connector === filterConnector);
  if (filterType) entries = entries.filter((e) => e.kind === filterType || e.action === filterType);
  if (from) entries = entries.filter((e) => new Date(e.timestamp).getTime() >= from);
  if (to) entries = entries.filter((e) => new Date(e.timestamp).getTime() <= to);

  const total = entries.length;
  const page = entries.slice(offset, offset + limit);
  res.json({ actions: page, total, limit, offset });
});

// ── Telemetry: decision trace log ─────────────────────────────────────────────
app.get("/api/decision-log", requireAuth, requireSuperAdmin, (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const filterEventType = req.query.eventType || null;

  const lines = tailFile(actionLogPath, 500).split("\n").filter(Boolean);
  let entries = lines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.kind === "decision");

  if (filterEventType) entries = entries.filter((e) => e.event_type === filterEventType);

  const traces = entries.slice(-limit).map((e) => ({
    timestamp: e.timestamp,
    eventType: e.event_type,
    connector: e.connector,
    channel: e.channel,
    intent: e.intent,
    role: e.role,
    personaModeKey: e.personaModeKey,
    engageReason: e.engageDecision?.reason || null,
    riskLevel: e.actionProposal?.risk_level || null,
    riskReason: e.riskDecision?.reason || null,
    executed: e.executionResult?.executed || false,
    judgeReasons: e.judgeReasons || [],
    judgePassed: e.judgePassed !== undefined ? e.judgePassed : null,
  }));

  res.json({ traces, total: traces.length });
});

app.get("/api/logs", requireAuth, requireSuperAdmin, (_req, res) => {
  res.json({
    connector: tailFile(connectorLogPath, 120),
    action: tailFile(actionLogPath, 120),
  });
});

app.get("/api/log", requireAuth, requireSuperAdmin, (_req, res) => {
  res.send(tailFile(connectorLogPath, 120));
});

app.get("/api/action-log", requireAuth, requireSuperAdmin, (_req, res) => {
  res.send(tailFile(actionLogPath, 120));
});

app.get("/api/threads-activity", requireAuth, requireSuperAdmin, (_req, res) => {
  const lines = tailFile(actionLogPath, 300).split("\n").filter(Boolean);
  const threadsEntries = lines
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((e) => e && e.kind === "threads_activity");

  const lastSession = threadsEntries.filter((e) => e.stage === "threads_session_end").slice(-1)[0] || null;
  const lastSessionStart = threadsEntries.filter((e) => e.stage === "threads_session_start").slice(-1)[0] || null;
  const lastLike = threadsEntries.filter((e) => e.stage === "threads_like").slice(-1)[0] || null;
  const lastReply = threadsEntries.filter((e) => e.stage === "threads_reply").slice(-1)[0] || null;
  const lastCommentQueued = threadsEntries.filter((e) => e.stage === "threads_comment_queued").slice(-1)[0] || null;
  const recentLikes = threadsEntries.filter((e) => e.stage === "threads_like").slice(-5);
  const commentProposalCount = threadsEntries.filter((e) => e.stage === "threads_comment_queued").length;
  const queueStats = getQueueStats();

  res.json({
    lastSession,
    lastSessionStart,
    lastLike,
    lastReply,
    lastCommentQueued,
    recentLikes,
    commentProposalCount,
    pending: queueStats.pending,
    approved: queueStats.approved,
  });
});

app.get("/api/threads-impressions", requireAuth, requireSuperAdmin, (_req, res) => {
  try {
    const { getTopAuthors, getTotalTracked } = require("./ai/threads_impression_store");
    res.json({
      topAuthors: getTopAuthors(10),
      totalTracked: getTotalTracked(),
      lastUpdatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Relationship memory management endpoints
app.get("/api/relationships", requireAuth, requireSuperAdmin, (_req, res) => {
  const users = listTopRelationships(30).map((u) => {
    const truth = getIdentityTruth(u.userId);
    return {
      userId: u.userId,
      nickname: u.nickname,
      familiarityScore: u.familiarityScore,
      interactionCount: u.interactionCount,
      lastInteractionAt: u.lastInteractionAt,
      role: truth.relationship.bondType === "primary" ? "developer" : truth.role || "public_user",
      sharedMemories: truth.relationship.sharedMemories || [],
    };
  });
  res.json({ users });
});

app.get("/api/relationships/:globalUserKey", requireAuth, requireSuperAdmin, (req, res) => {
  try {
    const truth = getIdentityTruth(req.params.globalUserKey);
    res.json(truth);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/relationships/:globalUserKey/memories", requireAuth, requireSuperAdmin, (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: "text required" });
  }
  addSharedMemory(req.params.globalUserKey, String(text).trim(), "manual");
  res.json({ ok: true });
});

app.delete("/api/relationships/:globalUserKey/memories/:index", requireAuth, requireSuperAdmin, (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isFinite(index)) return res.status(400).json({ error: "invalid index" });
  removeSharedMemory(req.params.globalUserKey, index);
  res.json({ ok: true });
});

app.get("/api/threads-moderation", requireAuth, (req, res) => {
  const status = req.query?.status || "pending";
  const sortBy = req.query?.sortBy || "createdAt";
  const rank = { L0: 0, L1: 1, L2: 2, L3: 3 };
  const items = listQueue(status).sort((a, b) => {
    if (sortBy === "riskLevel") {
      return (rank[b.riskLevel] ?? 99) - (rank[a.riskLevel] ?? 99);
    }
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  res.json({ items, stats: getQueueStats() });
});

app.post("/api/threads-smoke", requireAuth, requireSuperAdmin, async (_req, res) => {
  try {
    const result = await runThreadsSmoke();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/threads-self-posts", requireAuth, requireSuperAdmin, (_req, res) => {
  res.json({
    items: readSelfPosts(),
  });
});

app.get("/api/threads/external-rate-status", requireAuth, (_req, res) => {
  const status = canReplyExternal();
  res.json({
    hourCount: status.hourCount,
    hourLimit: status.limits.hour,
    dayCount: status.dayCount,
    dayLimit: status.limits.day,
    hourRemaining: Math.max(status.limits.hour - status.hourCount, 0),
    dayRemaining: Math.max(status.limits.day - status.dayCount, 0),
    limitReached: !status.allowed,
  });
});

app.post("/api/threads-self-posts", requireAuth, requireSuperAdmin, (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const postId = String(req.body?.postId || "").trim();
  if (!postId) {
    return res.status(400).json({ error: "postId required" });
  }

  const saved = recordSelfPost(postId, {
    source: "manual",
  });

  return res.json({
    success: true,
    item: saved,
  });
});

app.post("/api/threads-comment-test", requireAuth, requireSuperAdmin, async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const comment = req.body?.comment || req.body || {};
  const autoRegisterSelfPost = Boolean(req.body?.registerSelfPost);
  const skipCooldown = req.body?.skipCooldown !== false;

  if (autoRegisterSelfPost && comment?.postId) {
    recordSelfPost(comment.postId, { source: "test" });
  }

  const emitted = handleIncomingThreadComment(comment, { skipCooldown });
  let processed = null;

  if (emitted?.emitted) {
    processed = await processNextAction();
  }

  return res.json({
    success: true,
    emitted,
    processed,
    queue: getQueueStats(),
  });
});

app.post("/api/threads-autonomous", requireAuth, requireSuperAdmin, async (_req, res) => {
  try {
    const result = await runAutonomousSession();
    res.json({
      success: true,
      limits: {
        maxActionsPerSession: THREADS_MAX_ACTIONS_PER_SESSION,
        preferenceThreshold: "dynamic(0.60-0.80)",
        sessionDurationLimitMs: THREADS_SESSION_DURATION_LIMIT,
      },
      result,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/threads-auto-scan", requireAuth, requireSuperAdmin, async (_req, res) => {
  const now = Date.now();
  if (!canRunThreadsAutoScan(now)) {
    res.status(429).json({
      success: false,
      error: "threads auto scan hourly limit reached",
      limit: MAX_AUTO_SCAN_PER_HOUR,
    });
    return;
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

    if (detectThreadsLoginIssue(debug)) {
      debug.note = "Likely not logged in / checkpoint";
    }

    for (const post of posts) {
      await page.waitForTimeout(getMoodReadDelay(moodState.mood));

      const externalEvent = {
        type: "NEW_POST_IN_FEED",
        platform: "threads",
        connector: "threads_browser",
        channel: "public",
        interactionSource: "ai_initiated",
        personaModeKey: "public_user_public",
        username: post.authorUsername || null,
        authorUsername: post.authorUsername || null,
        targetUrl: post.url || null,
        postId: post.id,
        postText: post.text,
        content: post.text,
        originalPost: {
          postId: post.id,
          authorUsername: post.authorUsername || null,
          content: post.text,
          url: post.url || null,
        },
        originalComment: null,
        platformUserRef: post.authorUsername
          ? { platform: "threads", userId: null, username: post.authorUsername }
          : null,
      };

      if (shouldEngageExternalPost(externalEvent) && proposals.length < 2) {
        const { generateThreadsPublicReplyFromLLM } = require("./ai/pipeline");
        let publicReply;
        try {
          publicReply = await generateThreadsPublicReplyFromLLM(externalEvent);
        } catch {
          publicReply = buildThreadsPublicReply(externalEvent);
        }
        const proposal = planAction("reply", {
          platform: "threads",
          connector: "threads_browser",
          postId: post.id,
          targetUrl: post.url || null,
          proposalType: "reply_external_post",
          content: publicReply.replyText,
          type: "NEW_POST_IN_FEED",
          userId: null,
          originalPost: externalEvent.originalPost,
          originalComment: null,
        });

        enqueueModeration(
          proposal,
          { ...externalEvent, toneStyle: publicReply.toneProfile },
          { allowed: false, reason: "proposal_only" },
        );
        proposals.push(proposal);
      }
    }

    autoScanTimestamps.push(now);

    res.json({
      success: true,
      scanned: posts.length,
      evaluated: posts.length,
      proposals: proposals.length,
      limit: MAX_AUTO_SCAN_PER_HOUR,
      mood: moodState,
      debug,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/threads/backfill", requireAuth, requireSuperAdmin, async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const lookbackMinutes = Number(req.body?.lookbackMinutes || 60);

  try {
    const { backfillRecentComments } = require("./connectors/threads_browser/backfill");
    const result = await backfillRecentComments(lookbackMinutes);
    res.json({
      success: true,
      result,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

app.post("/api/threads/scan-notifications", requireAuth, requireSuperAdmin, async (_req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    const result = await runNotificationScan();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch("/api/threads-moderation/:id", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const item = editQueueItem(req.params.id, req.body?.editedContent);
  if (!item) {
    res.status(404).json({ error: "queue item not found" });
    return;
  }
  res.json(item);
});

app.post("/api/threads-moderation/:id/regenerate", requireAuth, async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const item = getQueueItem(req.params.id);
  if (!item) {
    res.status(404).json({ error: "queue item not found" });
    return;
  }
  if (item.status !== "pending") {
    res.status(400).json({ error: "queue item is not pending" });
    return;
  }

  const event = item.sourceEvent || null;
  if (!event || event.platform !== "threads") {
    res.status(400).json({ error: "source event unavailable for regeneration" });
    return;
  }

  try {
    const nextRegenerateIndex = Number(event.regenerateIndex || 0) + 1;
    const regenerated = await generateThreadsPublicReplyFromLLM({
      ...event,
      regenerateIndex: nextRegenerateIndex,
      previousReply: item.content || "",
    }, ollamaClient);

    const updated = regenerateQueueItem(item.id, {
      content: regenerated.replyText,
      toneProfile: regenerated.toneProfile,
      personaMode: regenerated.personaModeKey,
      sourceEvent: {
        ...event,
        regenerateIndex: nextRegenerateIndex,
        personaModeKey: regenerated.personaModeKey,
        toneStyle: regenerated.toneProfile,
      },
    });

    if (!updated) {
      res.status(500).json({ error: "failed to regenerate proposal" });
      return;
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message || "failed to regenerate proposal" });
  }
});

app.post("/api/threads-moderation/:id/approve", requireAuth, async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const item = getQueueItem(req.params.id);
  if (!item) {
    res.status(404).json({ error: "queue item not found" });
    return;
  }
  if (item.status !== "pending") {
    res.status(400).json({ error: "queue item is not pending" });
    return;
  }

  try {
    const execution = await executeThreadsAction({
      platform: item.platform,
      action: item.type,
      targetPostId: item.targetPostId,
      targetUrl: item.targetUrl,
      content: item.editedContent || item.content || "",
    });

    // Auto-register self post if executor returns a new postId (future: new_post action)
    if (execution?.success && execution?.newPostId) {
      recordSelfPost(execution.newPostId, { source: "auto", url: execution.newPostUrl || null });
    }

    const updated = approveQueueItem(item.id, req.body?.approvedBy || null, execution);
    res.json(updated);
  } catch (err) {
    const updated = approveQueueItem(item.id, req.body?.approvedBy || null, {
      success: false,
      error: err.message,
    });
    res.status(500).json(updated);
  }
});

app.post("/api/threads-moderation/:id/reject", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const updated = rejectQueueItem(req.params.id, req.body?.rejectedBy || null, req.body?.reason || "");
  if (!updated) {
    res.status(404).json({ error: "queue item not found" });
    return;
  }
  res.json(updated);
});

app.post("/api/chat", async (req, res) => {
  const userInput = req.body?.message || req.body?.text;

  if (!userInput || typeof userInput !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    const event = req.body?.event || {
      type: req.body?.eventType || "message",
      content: userInput,
      text: userInput,
      userId: req.body?.user_id || req.body?.userId || null,
      username: req.body?.username || null,
      connector: req.body?.connector || "api",
      isPrivate: Boolean(req.body?.isPrivate),
      channel: req.body?.channel || (req.body?.isPrivate ? "private" : "public"),
    };
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const context = buildContext(userInput, history, {
      event,
      userId: req.body?.user_id || req.body?.userId || null,
      username: req.body?.username || null,
      role: req.body?.role || "user",
    });
    const result = await generateAIReply(userInput, context, ollamaClient);
    res.json({
      reply: result.reply,
      skipped: Boolean(result.skipped),
      telemetry: result.telemetry,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// /voice-chat page
app.get("/voice-chat", (_req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "voice.html"));
});

// ─── Emotion Log ──────────────────────────────────────────────────────────────
app.get("/emotion-log", (_req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "emotion-log.html"));
});

app.get("/api/emotion-log", (_req, res) => {
  const moodState = getCurrentMood("Asia/Taipei");
  const recentEvents = getRecentMoodEvents(20);

  const residueDir = path.join(__dirname, "memory/emotional_residue");
  const perUserResidue = [];
  if (fs.existsSync(residueDir)) {
    for (const file of fs.readdirSync(residueDir).filter((f) => f.endsWith(".json"))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(residueDir, file), "utf-8"));
        const events = data.recentEmotionalEvents || [];
        const strongest = events.reduce(
          (max, e) => (e.intensity || 0) > (max.intensity || 0) ? e : max,
          { intensity: 0, type: "none" },
        );
        perUserResidue.push({
          userKey: file.replace(".json", ""),
          baselineMood: data.baselineMood || "CALM",
          moodDrift: Number((data.moodDrift || 0).toFixed(3)),
          eventCount: events.length,
          strongestType: strongest.type,
          strongestIntensity: Number((strongest.intensity || 0).toFixed(3)),
        });
      } catch { /* skip malformed */ }
    }
  }

  perUserResidue.sort((a, b) => b.moodDrift - a.moodDrift);
  res.json({ moodState, recentEvents, perUserResidue });
});

// ─── Memory Consolidation ─────────────────────────────────────────────────────
app.post("/api/memory/consolidate", (_req, res) => {
  const episodesDir = path.join(__dirname, "memory/episodes");
  const results = [];
  if (fs.existsSync(episodesDir)) {
    for (const file of fs.readdirSync(episodesDir).filter((f) => f.endsWith(".jsonl"))) {
      const userKey = file.replace(".jsonl", "");
      try {
        const result = consolidateEpisodes(userKey);
        results.push({ userKey, ...result });
      } catch (err) {
        results.push({ userKey, error: err.message });
      }
    }
  }
  res.json({ ok: true, results });
});

// ── LoRA Dashboard API ──────────────────────────────────────────────────────
const TRAIN_DIR = path.join(__dirname, "train");

function safeReadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return null; }
}

/** Scan train/ for adapter dirs matching pattern, sorted newest-first by mtime */
function getAdapterDirs() {
  if (!fs.existsSync(TRAIN_DIR)) return [];
  return fs.readdirSync(TRAIN_DIR)
    .filter(n => /^socialai_persona/.test(n) && fs.statSync(path.join(TRAIN_DIR, n)).isDirectory())
    .sort((a, b) => fs.statSync(path.join(TRAIN_DIR, b)).mtimeMs - fs.statSync(path.join(TRAIN_DIR, a)).mtimeMs);
}

/** Get latest checkpoint dir inside an adapter dir */
function getLatestCheckpoint(adapterPath) {
  const dirs = fs.readdirSync(adapterPath)
    .filter(n => /^checkpoint-\d+/.test(n))
    .sort((a, b) => parseInt(b.split("-")[1]) - parseInt(a.split("-")[1]));
  return dirs[0] ? path.join(adapterPath, dirs[0]) : null;
}

/** Read trainer_state.json from latest checkpoint of an adapter */
function getTrainerState(adapterName) {
  const adapterPath = path.join(TRAIN_DIR, adapterName);
  const ckpt = getLatestCheckpoint(adapterPath);
  if (ckpt) return safeReadJson(path.join(ckpt, "trainer_state.json"));
  return safeReadJson(path.join(adapterPath, "trainer_state.json"));
}

/** Find eval report files matching a label pattern */
function findEvalReports() {
  if (!fs.existsSync(TRAIN_DIR)) return [];
  return fs.readdirSync(TRAIN_DIR)
    .filter(n => /^eval_report_lora/.test(n) && n.endsWith(".json"))
    .sort((a, b) => b.localeCompare(a))
    .map(n => ({ file: n, data: safeReadJson(path.join(TRAIN_DIR, n)) }))
    .filter(x => x.data);
}

app.get("/api/pipeline/status", requireAuth, requireSuperAdmin, (_req, res) => {
  const adapters = getAdapterDirs();
  const latest = adapters[0];
  if (!latest) return res.json({ status: "no_adapters", uploadedSamples: 0 });

  const adapterPath = path.join(TRAIN_DIR, latest);
  const adapterConfig = safeReadJson(path.join(adapterPath, "adapter_config.json")) || {};
  const trainerState = getTrainerState(latest);
  const datasetAudit = safeReadJson(path.join(TRAIN_DIR, "dataset_audit.json")) || {};
  const reports = findEvalReports();
  const latestReport = reports[0]?.data;

  res.json({
    runId: latest,
    baseModel: adapterConfig.base_model_name_or_path || "unknown",
    model: adapterConfig.base_model_name_or_path || "unknown",
    uploadedSamples: datasetAudit.total_samples || 0,
    totalSamples: datasetAudit.total_samples || 0,
    aReviewed: latestReport?.total || 0,
    aReviewedCount: latestReport?.total || 0,
    bStatus: "pending",
    status: trainerState ? "completed" : "idle",
    adapter: `train/${latest}`,
    adapterCount: adapters.length,
  });
});

app.get("/api/dataset/files", requireAuth, requireSuperAdmin, (_req, res) => {
  const audit = safeReadJson(path.join(TRAIN_DIR, "dataset_audit.json")) || {};
  const files = [];
  // Look for JSONL files in train/
  if (fs.existsSync(TRAIN_DIR)) {
    fs.readdirSync(TRAIN_DIR).filter(n => n.endsWith(".jsonl") || n.endsWith(".json") && n.includes("dataset")).forEach(n => {
      const stat = fs.statSync(path.join(TRAIN_DIR, n));
      files.push({
        file: n,
        samples: audit.total_samples || "—",
        schema: audit.train_audit?.content_hit_count === 0 ? "OK" : "warnings",
        avgTokens: null,
        maxTokens: null,
        duplicates: audit.rejected_samples || 0,
      });
    });
  }
  if (!files.length) {
    files.push({ file: "dataset_audit.json", samples: audit.total_samples || 0, schema: "OK", duplicates: audit.rejected_samples || 0 });
  }
  res.json(files);
});

app.get("/api/dataset/validation", requireAuth, requireSuperAdmin, (_req, res) => {
  const audit = safeReadJson(path.join(TRAIN_DIR, "dataset_audit.json")) || {};
  const trainAudit = audit.train_audit || {};
  res.json({
    missingFields: trainAudit.content_hit_count || 0,
    illegalChars: trainAudit.content_hit_count || 0,
    emptySamples: audit.rejected_samples || 0,
    duplicateRate: `${((audit.rejected_samples || 0) / Math.max(audit.total_samples || 1, 1) * 100).toFixed(1)}%`,
  });
});

app.get("/api/scoring/a/status", requireAuth, requireSuperAdmin, (_req, res) => {
  const reports = findEvalReports();
  if (!reports.length) return res.json({ avgScore: 0, reviewed: 0, coverage: "0%", personaConsistency: "—", completed: false, total: 0 });
  const latest = reports[0].data;
  const passRate = Number((latest.passRate || 0) * 100).toFixed(1);
  const forbiddenHitRate = Number((latest.forbiddenHitRate || 0) * 100).toFixed(1);
  res.json({
    avgScore: passRate,
    reviewed: latest.total || 0,
    total: latest.total || 0,
    coverage: `${passRate}%`,
    personaConsistency: `${(100 - parseFloat(forbiddenHitRate)).toFixed(1)}%`,
    passRate: latest.passRate,
    forbiddenHitRate: latest.forbiddenHitRate,
    label: latest.label,
    adapter: latest.adapter,
    completed: (latest.passRate || 0) >= 0.5,
    process: latest.total,
  });
});

app.get("/api/scoring/b/status", requireAuth, requireSuperAdmin, (_req, res) => {
  res.json({
    preferenceSamples: 0,
    chosenRejectedRatio: "—",
    gateStatus: "未配置",
    mode: "DPO",
    processed: 0,
    total: 0,
    canStart: false,
    message: "尚未配置偏好學習資料集",
  });
});

app.post("/api/scoring/b/start", requireAuth, requireSuperAdmin, (_req, res) => {
  res.status(400).json({ ok: false, message: "尚未配置 DPO 資料集" });
});

app.get("/api/train/status", requireAuth, requireSuperAdmin, (_req, res) => {
  const adapters = getAdapterDirs();
  const latest = adapters[0];
  if (!latest) return res.json({ running: false, state: "idle" });

  const adapterPath = path.join(TRAIN_DIR, latest);
  const adapterConfig = safeReadJson(path.join(adapterPath, "adapter_config.json")) || {};
  const trainerState = getTrainerState(latest);
  const logHistory = trainerState?.log_history || [];
  const lastLog = logHistory.filter(r => r.loss !== undefined).slice(-1)[0] || {};

  res.json({
    baseModel: adapterConfig.base_model_name_or_path || "unknown",
    outputAdapter: latest,
    rank: adapterConfig.r || adapterConfig.lora_r || "—",
    alpha: adapterConfig.lora_alpha || "—",
    dropout: adapterConfig.lora_dropout || "—",
    batchSize: trainerState?.train_batch_size || "—",
    gradAccum: "—",
    running: false,
    state: "completed",
    step: trainerState?.global_step || 0,
    epoch: trainerState?.epoch || 0,
    loss: lastLog.loss,
    learningRate: lastLog.learning_rate,
    gpuUtil: null,
    gpuVram: null,
    tokensPerSec: null,
    samplesPerSec: null,
    gradNorm: lastLog.grad_norm,
  });
});

app.get("/api/train/metrics", requireAuth, requireSuperAdmin, (_req, res) => {
  const adapters = getAdapterDirs();
  const latest = adapters[0];
  if (!latest) return res.json([]);

  const trainerState = getTrainerState(latest);
  const rows = (trainerState?.log_history || [])
    .filter(r => r.loss !== undefined)
    .map(r => ({ step: r.step, loss: r.loss, learningRate: r.learning_rate, gradNorm: r.grad_norm, epoch: r.epoch }));
  res.json(rows);
});

app.get("/api/train/history", requireAuth, requireSuperAdmin, (_req, res) => {
  const adapters = getAdapterDirs();
  const reports = findEvalReports();
  const reportByAdapter = {};
  reports.forEach(r => {
    if (r.data?.adapter) {
      const key = r.data.adapter.replace("train/", "");
      reportByAdapter[key] = r.data;
    }
  });

  const history = adapters.map((name, i) => {
    const adapterPath = path.join(TRAIN_DIR, name);
    const config = safeReadJson(path.join(adapterPath, "adapter_config.json")) || {};
    const trainerState = getTrainerState(name);
    const logHistory = trainerState?.log_history || [];
    const lastLog = logHistory.filter(r => r.loss !== undefined).slice(-1)[0] || {};
    const report = reportByAdapter[name];
    return {
      id: adapters.length - i,
      adapter: name,
      baseModel: config.base_model_name_or_path || "—",
      rank: config.r || config.lora_r || "—",
      alpha: config.lora_alpha || "—",
      steps: trainerState?.global_step || "—",
      epoch: trainerState?.epoch || "—",
      loss: lastLog.loss ?? "—",
      score: report ? `${((report.passRate || 0) * 100).toFixed(0)}%` : "—",
      dataset: "persona",
    };
  });
  res.json(history);
});

app.post("/api/train/control", requireAuth, requireSuperAdmin, (req, res) => {
  const { action } = req.body || {};
  res.json({ ok: true, action, message: `訓練由 Python 腳本管理，請使用 WSL 執行 train_peft_qlora_7b.py。action=${action} 已記錄。` });
});

app.get("/api/conversation/samples", requireAuth, requireSuperAdmin, (_req, res) => {
  // Use latest eval report's details as conversation samples (base vs lora comparison)
  const reports = findEvalReports().slice(0, 2);
  if (!reports.length) return res.json([]);

  const latestReport = reports[0].data;
  const prevReport = reports[1]?.data;
  const prevById = {};
  if (prevReport?.details) prevReport.details.forEach(r => { prevById[r.id] = r; });

  const samples = (latestReport.details || []).map(r => ({
    id: r.id,
    userPrompt: r.input,
    baseReply: prevById[r.id]?.reply || "—",
    loraReply: r.reply,
    aScore: r.pass ? "pass" : "fail",
    preference: r.pass ? "chosen" : "rejected",
    drift: r.forbiddenHits?.length ? r.forbiddenHits.join(", ") : "—",
  }));
  res.json(samples);
});

app.get("/api/system/metrics", requireAuth, requireSuperAdmin, (_req, res) => {
  const os = require("os");
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const ramPct = ((usedMem / totalMem) * 100).toFixed(1);
  const ramStr = `${(usedMem / 1024 / 1024 / 1024).toFixed(1)}GB / ${(totalMem / 1024 / 1024 / 1024).toFixed(1)}GB`;
  res.json({
    gpu: "—",
    gpuUtil: null,
    gpuVram: "—",
    cpu: null,
    ram: ramStr,
    ramPct,
    uptime: process.uptime(),
    history: [],
  });
});

app.get("/api/audit/logs", requireAuth, requireSuperAdmin, (_req, res) => {
  const logPath = path.join(TRAIN_DIR, "server_stdout.log");
  const logs = [];
  if (fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean).slice(-50);
    lines.forEach((line, i) => {
      logs.push({ time: `#${i + 1}`, actor: "train", action: "log", detail: line.slice(0, 120) });
    });
  }
  res.json(logs.reverse().slice(0, 30));
});

app.get("/api/agents", requireAuth, requireSuperAdmin, (_req, res) => {
  res.json([
    { name: "dataset-builder", status: "idle", desc: "generate_persona_dataset.py" },
    { name: "sft-trainer-7b", status: "idle", desc: "train_peft_qlora_7b.py" },
    { name: "sft-trainer-14b", status: "idle", desc: "train_peft_qlora_14b.py" },
    { name: "unsloth-trainer", status: "idle", desc: "train_unsloth.py" },
    { name: "eval-runner", status: "idle", desc: "run_eval_local_lora.py" },
  ]);
});

app.get("/api/tasks/recent", requireAuth, requireSuperAdmin, (_req, res) => {
  const adapters = getAdapterDirs().slice(0, 5);
  const tasks = adapters.map(name => {
    const ts = getTrainerState(name);
    return {
      title: name,
      action: "training",
      time: ts ? `step ${ts.global_step}, epoch ${ts.epoch}` : "—",
      status: "completed",
    };
  });
  res.json(tasks);
});

app.get("/api/services", requireAuth, requireSuperAdmin, (_req, res) => {
  res.json([
    { name: "Ollama LLM", status: "up" },
    { name: "SocialAI Server", status: "up" },
    { name: "Telegram Bot", status: "up" },
    { name: "Threads Connector", status: "up" },
    { name: "WSL Train Env", status: "idle" },
  ]);
});

app.post("/api/inference", requireAuth, requireSuperAdmin, async (req, res) => {
  const { prompt, systemPersona } = req.body || {};
  if (!prompt) return res.status(400).json({ ok: false, message: "prompt required" });
  try {
    const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
    const model = process.env.LLM_MODEL || "qwen2.5:7b";
    const messages = [];
    if (systemPersona) messages.push({ role: "system", content: systemPersona });
    messages.push({ role: "user", content: prompt });
    const response = await axios.post(`${ollamaUrl}/api/chat`, {
      model,
      messages,
      stream: false,
    }, { timeout: 30000 });
    const output = response.data?.message?.content || response.data?.response || "（無回應）";
    res.json({ ok: true, output, model });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});
// ── Review Queue (Human-in-the-loop) ────────────────────────────────────────
const REVIEW_A_PATH = path.join(TRAIN_DIR, "review_a_state.json");
const REVIEW_B_PATH = path.join(TRAIN_DIR, "review_b_state.json");
const DATASET_V2_PATH = path.join(__dirname, "..", "dataset_v2", "dataset_v2_merged_5000.json");
const INFER_RESULTS_PATH = path.join(TRAIN_DIR, "inference_results.jsonl");

function readReview(p) { return safeReadJson(p) || null; }
function writeReview(p, state) { fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf-8"); }

// ── Background Inference Generation Job ─────────────────────────────────────
let _genJob = { running: false, total: 0, done: 0, failed: 0, aborted: false, startedAt: null };

// Auto-resume on server startup if partial progress exists
setTimeout(() => {
  try {
    if (!fs.existsSync(INFER_RESULTS_PATH) || !fs.existsSync(DATASET_V2_PATH)) return;
    const lines = fs.readFileSync(INFER_RESULTS_PATH, "utf-8").trim().split("\n").filter(Boolean);
    const fileCount = lines.length;
    if (fileCount === 0) return;
    const prompts = JSON.parse(fs.readFileSync(DATASET_V2_PATH, "utf-8")).map((p, i) => ({ ...p, _idx: i }));
    if (fileCount >= prompts.length) return; // Already complete
    const resumeSet = new Set();
    lines.forEach(l => { try { resumeSet.add(JSON.parse(l).idx); } catch {} });
    console.log(`[GEN JOB] 自動恢復生成：已完成 ${fileCount}/${prompts.length}，繼續剩餘 ${prompts.length - fileCount} 條`);
    _genJob = { running: true, total: prompts.length, done: fileCount, failed: 0, aborted: false, startedAt: new Date().toISOString() };
    runGenerationJob(prompts, resumeSet, 3).catch(err => {
      console.error("[GEN JOB] 自動恢復失敗:", err.message);
      _genJob.running = false;
    });
  } catch (e) {
    console.error("[GEN JOB] 自動恢復檢查失敗:", e.message);
  }
}, 5000);

async function runGenerationJob(prompts, resumeSet, concurrency) {
  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  const model = process.env.LLM_MODEL || "qwen3:8b";
  const systemPrompt = "你是晴，一個真實的人在傳訊息。語氣口語自然，有個性。直接回應，不打招呼。最多2-3句。禁止emoji。";
  const fd = fs.openSync(INFER_RESULTS_PATH, "a");

  const todo = prompts.filter(p => !resumeSet.has(p._idx));

  async function processOne(item) {
    if (_genJob.aborted) return;
    try {
      const resp = await axios.post(`${ollamaUrl}/api/chat`, {
        model, stream: false, think: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: item.prompt },
        ],
      }, { timeout: 90000 });
      const reply = (resp.data?.message?.content || "").trim();
      const line = JSON.stringify({ idx: item._idx, category: item.category, prompt: item.prompt, reply, model, ts: Date.now() }) + "\n";
      fs.writeSync(fd, line);
      _genJob.done++;
    } catch { _genJob.failed++; }
  }

  // Process in concurrent batches
  for (let i = 0; i < todo.length; i += concurrency) {
    if (_genJob.aborted) break;
    await Promise.all(todo.slice(i, i + concurrency).map(processOne));
  }

  fs.closeSync(fd);
  _genJob.running = false;
}

app.post("/api/review/a/generate", requireAuth, requireSuperAdmin, async (req, res) => {
  if (_genJob.running) return res.json({ ok: false, message: "已在生成中", job: _genJob });
  if (!fs.existsSync(DATASET_V2_PATH)) return res.status(404).json({ ok: false, message: "找不到 dataset_v2_merged_5000.json" });

  const prompts = JSON.parse(fs.readFileSync(DATASET_V2_PATH, "utf-8")).map((p, i) => ({ ...p, _idx: i }));

  // Load already-generated indices for resume
  const resumeSet = new Set();
  if (fs.existsSync(INFER_RESULTS_PATH)) {
    fs.readFileSync(INFER_RESULTS_PATH, "utf-8").trim().split("\n").filter(Boolean).forEach(l => {
      try { resumeSet.add(JSON.parse(l).idx); } catch {}
    });
  }

  const concurrency = Math.min(10, Math.max(1, Number(req.body?.concurrency) || 3));
  _genJob = { running: true, total: prompts.length, done: resumeSet.size, failed: 0, aborted: false, startedAt: new Date().toISOString() };

  runGenerationJob(prompts, resumeSet, concurrency).catch(err => {
    console.error("[GEN JOB]", err.message);
    _genJob.running = false;
  });

  res.json({ ok: true, total: prompts.length, alreadyDone: resumeSet.size, remaining: prompts.length - resumeSet.size, concurrency });
});

app.get("/api/review/a/generate/status", requireAuth, requireSuperAdmin, (_req, res) => {
  // Also count lines in file for accurate count
  let fileCount = 0;
  if (fs.existsSync(INFER_RESULTS_PATH)) {
    fileCount = fs.readFileSync(INFER_RESULTS_PATH, "utf-8").trim().split("\n").filter(Boolean).length;
  }
  const done = Math.max(_genJob.done, fileCount);
  const total = _genJob.total || 5000;
  res.json({ ..._genJob, done, fileCount, pct: (done / total * 100).toFixed(1) });
});

app.post("/api/review/a/generate/stop", requireAuth, requireSuperAdmin, (_req, res) => {
  _genJob.aborted = true;
  res.json({ ok: true, done: _genJob.done });
});

// Init A queue — source: "eval" | "training" | "inference" (from generated results)
app.post("/api/review/a/init", requireAuth, requireSuperAdmin, (req, res) => {
  const source = req.body?.source || "training";

  if (source === "inference") {
    if (!fs.existsSync(INFER_RESULTS_PATH)) return res.status(404).json({ ok: false, message: "尚未生成推論結果，請先執行生成" });
    const lines = fs.readFileSync(INFER_RESULTS_PATH, "utf-8").trim().split("\n").filter(Boolean);
    const items = lines.map(l => {
      try {
        const d = JSON.parse(l);
        return { id: `inf_${d.idx}`, input: d.prompt, reply: d.reply, category: d.category, source: "inference", autoPass: null, forbiddenHits: [], artifact: false, status: "pending", reviewer: null, reviewedAt: null, note: "" };
      } catch { return null; }
    }).filter(Boolean);
    if (!items.length) return res.status(404).json({ ok: false, message: "推論結果檔案是空的" });
    const adapters = getAdapterDirs();
    const state = { source: "inference", adapter: adapters[0] || "unknown", initializedAt: new Date().toISOString(), items };
    writeReview(REVIEW_A_PATH, state);
    return res.json({ ok: true, total: items.length, source: "inference" });
  }

  if (source === "eval") {
    const reports = findEvalReports();
    if (!reports.length) return res.status(404).json({ ok: false, message: "找不到 eval report" });
    const latest = reports[0];
    const details = latest.data?.details || [];
    if (!details.length) return res.status(404).json({ ok: false, message: "eval report 沒有 details" });
    const state = {
      source: "eval", adapter: latest.data.adapter || latest.data.label, report: latest.file,
      initializedAt: new Date().toISOString(),
      items: details.map(d => ({
        id: d.id, input: d.input, reply: d.reply,
        autoPass: d.pass, forbiddenHits: d.forbiddenHits || [], artifact: d.artifact || false,
        status: "pending", reviewer: null, reviewedAt: null, note: "",
      })),
    };
    writeReview(REVIEW_A_PATH, state);
    return res.json({ ok: true, total: state.items.length, source: "eval" });
  }

  // source === "training": read all training JSONL files
  const items = [];
  if (fs.existsSync(TRAIN_DIR)) {
    const jsonlFiles = fs.readdirSync(TRAIN_DIR)
      .filter(n => n.endsWith(".jsonl") && n.startsWith("socialai_persona") && n.includes("train"))
      .sort();
    jsonlFiles.forEach(file => {
      const raw = fs.readFileSync(path.join(TRAIN_DIR, file), "utf-8").trim().split("\n");
      raw.forEach((line, i) => {
        try {
          const d = JSON.parse(line);
          const msgs = d.messages || d.conversations || [];
          const userMsg = msgs.find(m => m.role === "user");
          const assistantMsg = msgs.find(m => m.role === "assistant");
          if (userMsg && assistantMsg) {
            items.push({
              id: `${file.replace(".jsonl", "")}_${i + 1}`,
              input: userMsg.content,
              reply: assistantMsg.content,
              source: file,
              autoPass: null, forbiddenHits: [], artifact: false,
              status: "pending", reviewer: null, reviewedAt: null, note: "",
            });
          }
        } catch {}
      });
    });
  }

  // Also merge eval report details (append at end)
  const reports = findEvalReports();
  if (reports.length) {
    const latest = reports[0];
    (latest.data?.details || []).forEach(d => {
      if (!items.find(x => x.id === d.id)) {
        items.push({
          id: d.id, input: d.input, reply: d.reply, source: "eval",
          autoPass: d.pass, forbiddenHits: d.forbiddenHits || [], artifact: d.artifact || false,
          status: "pending", reviewer: null, reviewedAt: null, note: "",
        });
      }
    });
  }

  if (!items.length) return res.status(404).json({ ok: false, message: "找不到訓練資料" });

  const adapters = getAdapterDirs();
  const state = {
    source: "training", adapter: adapters[0] || "unknown",
    initializedAt: new Date().toISOString(), items,
  };
  writeReview(REVIEW_A_PATH, state);
  res.json({ ok: true, total: items.length, source: "training" });
});

const SCORE_LABELS = ["", "語意錯誤", "勉強表達", "接不到情緒", "缺少人感", "完美"];

app.get("/api/review/a/progress", requireAuth, requireSuperAdmin, (_req, res) => {
  const state = readReview(REVIEW_A_PATH);
  if (!state) return res.json({ initialized: false, total: 0, done: 0, pending: 0, scores: {} });
  const items = state.items;
  const scores = { 1:0, 2:0, 3:0, 4:0, 5:0 };
  items.forEach(x => { if (x.score) scores[x.score] = (scores[x.score] || 0) + 1; });
  res.json({
    initialized: true, adapter: state.adapter,
    total: items.length,
    done: items.filter(x => x.status !== "pending").length,
    pending: items.filter(x => x.status === "pending").length,
    scores,
  });
});

app.get("/api/review/a/next", requireAuth, requireSuperAdmin, (_req, res) => {
  const state = readReview(REVIEW_A_PATH);
  if (!state) return res.status(404).json({ ok: false, message: "尚未初始化" });
  const item = state.items.find(x => x.status === "pending");
  const done = state.items.filter(x => x.status !== "pending").length;
  if (!item) return res.json({ finished: true, total: state.items.length, done });
  res.json({ item, done, total: state.items.length, adapter: state.adapter });
});

app.post("/api/review/a/submit", requireAuth, requireSuperAdmin, (req, res) => {
  const { id, score, note } = req.body || {};
  const s = Number(score);
  if (!id || !s || s < 1 || s > 5) return res.status(400).json({ ok: false, message: "id and score (1-5) required" });
  const state = readReview(REVIEW_A_PATH);
  if (!state) return res.status(404).json({ ok: false, message: "尚未初始化" });
  const item = state.items.find(x => x.id === id);
  if (!item) return res.status(404).json({ ok: false, message: "找不到項目" });
  item.status = "scored";
  item.score = s;
  item.reviewer = (req.headers["x-team-token"] || "").slice(0, 8) + "…";
  item.reviewedAt = new Date().toISOString();
  item.note = note || "";
  writeReview(REVIEW_A_PATH, state);
  const done = state.items.filter(x => x.status !== "pending").length;
  res.json({ ok: true, done, total: state.items.length, allDone: done === state.items.length });
});

app.post("/api/review/a/reset", requireAuth, requireSuperAdmin, (_req, res) => {
  if (fs.existsSync(REVIEW_A_PATH)) fs.unlinkSync(REVIEW_A_PATH);
  res.json({ ok: true });
});

// Init B queue from two consecutive eval reports (prev vs latest)
app.post("/api/review/b/init", requireAuth, requireSuperAdmin, (_req, res) => {
  const reports = findEvalReports().slice(0, 2);
  if (reports.length < 2) return res.status(404).json({ ok: false, message: "需要至少 2 個 eval report" });
  const [later, prev] = reports;
  const prevById = {};
  (prev.data?.details || []).forEach(x => { prevById[x.id] = x; });
  const pairs = (later.data?.details || [])
    .filter(x => prevById[x.id])
    .map(x => ({
      id: x.id, input: x.input,
      responseA: prevById[x.id].reply, labelA: prev.data?.label || prev.file,
      responseB: x.reply,            labelB: later.data?.label || later.file,
      status: "pending", reviewer: null, reviewedAt: null,
    }));
  if (!pairs.length) return res.status(404).json({ ok: false, message: "兩個 report 沒有共同 id" });
  const state = {
    labelA: prev.data?.label, labelB: later.data?.label,
    initializedAt: new Date().toISOString(), items: pairs,
  };
  writeReview(REVIEW_B_PATH, state);
  res.json({ ok: true, total: pairs.length, labelA: state.labelA, labelB: state.labelB });
});

app.get("/api/review/b/progress", requireAuth, requireSuperAdmin, (_req, res) => {
  const state = readReview(REVIEW_B_PATH);
  if (!state) return res.json({ initialized: false, total: 0, done: 0 });
  const items = state.items;
  res.json({
    initialized: true, labelA: state.labelA, labelB: state.labelB,
    total: items.length,
    done: items.filter(x => x.status !== "pending").length,
    a_better: items.filter(x => x.status === "a_better").length,
    b_better: items.filter(x => x.status === "b_better").length,
    tie: items.filter(x => x.status === "tie").length,
    skip: items.filter(x => x.status === "skip").length,
  });
});

app.get("/api/review/b/next", requireAuth, requireSuperAdmin, (_req, res) => {
  const state = readReview(REVIEW_B_PATH);
  if (!state) return res.status(404).json({ ok: false, message: "尚未初始化" });
  const item = state.items.find(x => x.status === "pending");
  const done = state.items.filter(x => x.status !== "pending").length;
  if (!item) return res.json({ done: true, total: state.items.length });
  res.json({ pair: item, done, total: state.items.length, labelA: state.labelA, labelB: state.labelB });
});

app.post("/api/review/b/submit", requireAuth, requireSuperAdmin, (req, res) => {
  const { id, preference } = req.body || {};
  if (!id || !preference) return res.status(400).json({ ok: false, message: "id and preference required" });
  const state = readReview(REVIEW_B_PATH);
  if (!state) return res.status(404).json({ ok: false, message: "尚未初始化" });
  const item = state.items.find(x => x.id === id);
  if (!item) return res.status(404).json({ ok: false, message: "找不到項目" });
  item.status = preference;
  item.reviewer = (req.headers["x-team-token"] || "").slice(0, 8) + "…";
  item.reviewedAt = new Date().toISOString();
  writeReview(REVIEW_B_PATH, state);
  const done = state.items.filter(x => x.status !== "pending").length;
  res.json({ ok: true, done, total: state.items.length, allDone: done === state.items.length });
});

app.post("/api/review/b/reset", requireAuth, requireSuperAdmin, (_req, res) => {
  if (fs.existsSync(REVIEW_B_PATH)) fs.unlinkSync(REVIEW_B_PATH);
  res.json({ ok: true });
});

// Training live progress – parse latest log for current/total step
app.get("/api/train/live", requireAuth, requireSuperAdmin, (_req, res) => {
  const adapters = getAdapterDirs();
  const latest = adapters[0];
  let currentStep = 0, totalSteps = 0, logLines = [];

  if (latest) {
    const ts = getTrainerState(latest);
    currentStep = ts?.global_step || 0;
    const logHistory = ts?.log_history || [];
    const trainingLogs = logHistory.filter(r => r.loss !== undefined);
    totalSteps = trainingLogs.length ? Math.max(...trainingLogs.map(r => r.step)) : currentStep;

    const logFiles = fs.existsSync(TRAIN_DIR)
      ? fs.readdirSync(TRAIN_DIR)
          .filter(n => n.startsWith("train_run") && n.endsWith(".log"))
          .sort((a, b) => fs.statSync(path.join(TRAIN_DIR, b)).mtimeMs - fs.statSync(path.join(TRAIN_DIR, a)).mtimeMs)
      : [];
    if (logFiles.length) {
      const raw = fs.readFileSync(path.join(TRAIN_DIR, logFiles[0]), "utf-8");
      const lines = raw.split("\n").filter(l => l.trim() && !l.includes("[A"));
      logLines = lines.slice(-30);
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/\|\s*(\d+)\/(\d+)\s*\[/);
        if (m) { currentStep = parseInt(m[1]); totalSteps = totalSteps || parseInt(m[2]); break; }
      }
    }
  }

  res.json({
    currentStep, totalSteps: totalSteps || currentStep,
    pct: totalSteps > 0 ? Math.min(100, (currentStep / totalSteps) * 100).toFixed(1) : 100,
    log: logLines.join("\n"),
  });
});
// ── End LoRA Dashboard API ───────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`SocialAI running at http://localhost:${PORT}`);
});

// ─── Voice Chat WebSocket ─────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: "/ws/voice" });
wss.on("connection", (ws) => {
  const sessionHistory = [];

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== "speak" && msg.type !== "initiate") return;

    const isInitiate = msg.type === "initiate";
    const userText = isInitiate ? null : String(msg.text || "").trim();
    if (!isInitiate && !userText) return;

    // Choose prompt: user reply vs. proactive initiation
    const prompt = isInitiate
      ? (sessionHistory.length === 0
          ? "現在開始語音對話，你主動說第一句話，說你現在腦海裡浮現的任何事情，不要說「你好」之類的問候，直接說你想說的。"
          : "對話沉默了一段時間，你主動說一句話，可以繼續剛才的話題、說你突然想到的事，或者問對方一個具體的問題。說話自然，不解釋為什麼突然說話。")
      : userText;

    if (!isInitiate) ws.send(JSON.stringify({ type: "thinking" }));

    try {
      const context = buildContext(prompt, sessionHistory, {
        userId: null,
        username: null,
        role: "developer",
        connector: "voice",
        channel: "private",
        isPrivate: true,
      });

      let fullReply = "";
      let chunkIndex = 0;

      for await (const sentence of generateVoiceReplyStream(prompt, context, ollamaClient)) {
        fullReply += sentence;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "audio_chunk", text: sentence, index: chunkIndex++ }));
        }
      }

      // Save to history: for user messages save both sides; for initiate save only AI reply
      if (!isInitiate) sessionHistory.push({ role: "user", text: userText });
      if (fullReply)   sessionHistory.push({ role: "bot", text: fullReply });
      if (sessionHistory.length > 40) sessionHistory.splice(0, 4);

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "reply_done", text: fullReply }));
      }
    } catch (err) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", message: err.message }));
      }
    }
  });
});

setInterval(() => {
  processNextAction().catch((err) => {
    console.error("[PRIORITY SCHEDULER] processNextAction failed:", err.message);
  });
}, 5000);

if (process.env.THREADS_PAUSED === "1") {
  console.log("[THREADS] THREADS_PAUSED=1 — Threads activity loop disabled. Telegram-only mode.");
} else {
  getThreadsContext().catch((err) => {
    console.error("[THREADS EXECUTOR] preload failed:", err.message);
  });
  startActivityLoop();
}

require("./connectors/telegram/bot");
