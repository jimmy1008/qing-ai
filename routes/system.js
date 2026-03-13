const express = require("express");
const { requireAuth, requireSuperAdmin } = require("../auth/auth_middleware");
const { getConnectorMetrics } = require("../metrics/connector_metrics");
const { getEventMetrics } = require("../metrics/event_metrics");
const { getActionMetrics } = require("../metrics/action_metrics");
const { getReflexMetrics } = require("../metrics/reflex_metrics");
const { getConversationMetrics } = require("../metrics/conversation_metrics");
const { getMemoryMetrics } = require("../metrics/memory_metrics");
const stabilityWindow = require("../metrics/stability_window");
const { evaluateAlerts } = require("../metrics/alert_rules");
const historyBuffer = require("../metrics/history_buffer");
const { getQueueStats } = require("../ai/moderation_queue");
const { getAISnapshot, getAIThoughtsSnapshot } = require("../ai/state_snapshot");
const { getLLMQueueStats } = require("../ai/llm_queue");
const { getStats: getWorkingMemoryStats } = require("../ai/memory/working_memory");
const fs = require("fs");
const path = require("path");

function tailFile(filePath, limit = 80) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean).slice(-limit).join("\n");
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return fallback; }
}

module.exports = function createSystemRouter({ startTime, connectorLogPath, actionLogPath }) {
  const personaRegressionPath = path.join(__dirname, "..", "train", "persona_mode_regression_report.json");
  const engageRegressionPath  = path.join(__dirname, "..", "train", "engage_filter_regression_report.json");

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
    return {
      connector: getConnectorMetrics(), events: getEventMetrics(), actions, memory,
      regressions: { persona: readJson(personaRegressionPath), engage: readJson(engageRegressionPath) },
      reflex: currentReflexMetrics, conversation, rolling, history, healthScore, alerts,
      risk: { high_risk_count: actions.L3, pending_review: actions.pending_review },
      system: { uptime_sec: Math.floor((Date.now() - startTime) / 1000), timestamp: new Date().toISOString() },
    };
  }

  function buildAnalysisSummary() {
    const metrics = buildMetricsPayload();
    return {
      actions: {
        pending_review: metrics.actions.pending_review, threads_pending: metrics.actions.threads_pending,
        engage_rate: metrics.actions.engage_rate, ignore_rate: metrics.actions.ignore_rate,
        top_ignore_reason: metrics.actions.top_ignore_reason, top_engage_reason: metrics.actions.top_engage_reason,
        persona_mode_dist: metrics.actions.persona_mode_dist, hostile_ignore_rate: metrics.actions.hostile_ignore_rate,
        low_signal_ignore_rate: metrics.actions.low_signal_ignore_rate,
      },
      regressions: metrics.regressions, queue: getQueueStats(),
      system: { timestamp: metrics.system.timestamp },
    };
  }

  const router = express.Router();

  router.get("/api/me",              requireAuth,                   (req, res) => res.json({ role: req.userRole }));
  // LLM queue live stats — visible to all auth'd users (no sensitive data)
  router.get("/api/status/llm-queue", requireAuth, (_req, res) => {
    const q = getLLMQueueStats();
    const wm = getWorkingMemoryStats();
    res.json({ llm_queue: q, working_memory: wm, timestamp: Date.now() });
  });
  router.get("/api/metrics",         requireAuth, requireSuperAdmin, (_req, res) => res.json(buildMetricsPayload()));
  router.get("/api/analysis-summary",requireAuth,                   (_req, res) => res.json(buildAnalysisSummary()));
  router.get("/api/ai-cognition",    requireAuth, requireSuperAdmin, (_req, res) => res.json(getAISnapshot()));
  router.get("/api/ai-thoughts",     requireAuth, requireSuperAdmin, (_req, res) => res.json(getAIThoughtsSnapshot()));
  router.get("/api/system-health",   requireAuth, requireSuperAdmin, (_req, res) => {
    const m = buildMetricsPayload();
    res.json({ connector: m.connector, healthScore: m.healthScore, alerts: m.alerts, system: m.system, risk: m.risk });
  });
  router.get("/api/full-audit",  requireAuth, requireSuperAdmin, (_req, res) => res.json(buildMetricsPayload()));
  router.get("/api/telemetry",   requireAuth, requireSuperAdmin, (_req, res) => {
    const m = buildMetricsPayload();
    res.json({ reflex: m.reflex, conversation: m.conversation, rolling: m.rolling, history: m.history, memory: m.memory });
  });
  router.get("/api/action-metrics", requireAuth, requireSuperAdmin, (_req, res) => res.json(getActionMetrics()));

  router.get("/api/ai-actions", requireAuth, requireSuperAdmin, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const { connector: fc, type: ft, from, to } = req.query;
    let entries = tailFile(actionLogPath, 1000).split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (fc) entries = entries.filter(e => e.connector === fc);
    if (ft) entries = entries.filter(e => e.kind === ft || e.action === ft);
    if (from) entries = entries.filter(e => new Date(e.timestamp).getTime() >= Number(from));
    if (to)   entries = entries.filter(e => new Date(e.timestamp).getTime() <= Number(to));
    res.json({ actions: entries.slice(offset, offset + limit), total: entries.length, limit, offset });
  });

  router.get("/api/decision-log", requireAuth, requireSuperAdmin, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    let entries = tailFile(actionLogPath, 500).split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.kind === "decision");
    if (req.query.eventType) entries = entries.filter(e => e.event_type === req.query.eventType);
    const traces = entries.slice(-limit).map(e => ({
      timestamp: e.timestamp, eventType: e.event_type, connector: e.connector, channel: e.channel,
      intent: e.intent, role: e.role, personaModeKey: e.personaModeKey,
      engageReason: e.engageDecision?.reason || null, riskLevel: e.actionProposal?.risk_level || null,
      riskReason: e.riskDecision?.reason || null, executed: e.executionResult?.executed || false,
      judgeReasons: e.judgeReasons || [], judgePassed: e.judgePassed !== undefined ? e.judgePassed : null,
    }));
    res.json({ traces, total: traces.length });
  });

  router.get("/api/logs",       requireAuth, requireSuperAdmin, (_req, res) =>
    res.json({ connector: tailFile(connectorLogPath, 120), action: tailFile(actionLogPath, 120) }));
  router.get("/api/log",        requireAuth, requireSuperAdmin, (_req, res) => res.send(tailFile(connectorLogPath, 120)));
  router.get("/api/action-log", requireAuth, requireSuperAdmin, (_req, res) => res.send(tailFile(actionLogPath, 120)));

  return router;
};
