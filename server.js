const path = require("path");
const fs   = require("fs");
const dotenv = require("dotenv");
const WebSocket = require("ws");

// ── Process-level error capture → memory/error_log.jsonl ─────────────────────
const ERROR_LOG = path.join(__dirname, "memory/error_log.jsonl");
function _appendError(type, message, stack) {
  try {
    const entry = { ts: Date.now(), type, message: String(message || ""), stack: String(stack || "").split("\n")[1] || "" };
    fs.appendFileSync(ERROR_LOG, JSON.stringify(entry) + "\n", "utf-8");
  } catch {}
}
process.on("uncaughtException",  err    => _appendError("uncaughtException",  err?.message, err?.stack));
process.on("unhandledRejection", reason => _appendError("unhandledRejection", reason?.message || String(reason), reason?.stack));

dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config({ path: path.join(__dirname, ".env.local"), override: true });

const express = require("express");
const { createOllamaClient, buildContext } = require("./ai/pipeline");
const { processNextAction } = require("./ai/action_planner");
const { startActivityLoop } = require("./ai/threads_activity_scheduler");
const { getThreadsContext } = require("./connectors/threads_browser/browser_manager");

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

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use("/api", (_req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});
app.use(express.static(path.join(__dirname, "dashboard")));

// ── Route modules ─────────────────────────────────────────────────────────────
app.use(require("./routes/pages"));
app.use(require("./routes/system")({ startTime, connectorLogPath, actionLogPath }));
app.use(require("./routes/relationships"));
app.use(require("./routes/chat")({ ollamaClient }));
app.use(require("./routes/threads"));
app.use(require("./routes/lora").router);
app.use(require("./routes/review"));
app.use(require("./routes/trading"));
const { startScheduler } = require("./ai/modules/trading/trading_scheduler");

app.get("/trading", (_req, res) => res.sendFile(path.join(__dirname, "dashboard", "trading.html")));
app.get("/chart",   (_req, res) => res.sendFile(path.join(__dirname, "dashboard", "chart.html")));

// ── System error log ──────────────────────────────────────────────────────────
app.get("/api/system/errors", (_req, res) => {
  try {
    if (!fs.existsSync(ERROR_LOG)) return res.json([]);
    const lines = fs.readFileSync(ERROR_LOG, "utf-8").split("\n").filter(Boolean);
    const errors = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.json(errors.slice(-100).reverse());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/system/errors/clear", (_req, res) => {
  try { if (fs.existsSync(ERROR_LOG)) fs.writeFileSync(ERROR_LOG, "", "utf-8"); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Auto memory consolidation — runs daily at 04:00 Taiwan time ───────────────
function scheduleMemoryConsolidation() {
  const { consolidateEpisodes } = require("./ai/episodic_store");
  const fs   = require("fs");
  const path = require("path");
  const EPISODES_DIR = path.join(__dirname, "memory/episodes");

  function runConsolidation() {
    try {
      if (!fs.existsSync(EPISODES_DIR)) return;
      const files = fs.readdirSync(EPISODES_DIR).filter(f => f.endsWith(".jsonl"));
      let totalRemoved = 0, totalMerged = 0;
      for (const f of files) {
        const userKey = f.replace(".jsonl", "");
        try {
          const r = consolidateEpisodes(userKey);
          totalRemoved += r.removed || 0;
          totalMerged  += r.merged  || 0;
        } catch { /* per-user errors are silent */ }
      }
      console.log(`[memory] daily consolidation: ${files.length} users, removed=${totalRemoved}, merged=${totalMerged}`);
    } catch (e) {
      console.warn("[memory] consolidation failed:", e.message);
    }
  }

  // Schedule: run once daily. Calculate ms until next 04:00 Taipei (UTC+8).
  function msUntilNext4am() {
    const now = new Date();
    const taipei = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
    const next = new Date(taipei);
    next.setHours(4, 0, 0, 0);
    if (next <= taipei) next.setDate(next.getDate() + 1);
    return next - taipei;
  }
  setTimeout(function tick() {
    runConsolidation();
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }, msUntilNext4am());
  console.log(`[memory] consolidation scheduled (next run in ${Math.round(msUntilNext4am()/3600000)}h)`);
}

// ── Start HTTP server ─────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`SocialAI running at http://localhost:${PORT}`);
  startScheduler(); // 晴開始自主看盤排程
  scheduleMemoryConsolidation();

  // Pre-warm main model so first conversation request doesn't pay load cost
  const axios = require("axios");
  const _OLLAMA = process.env.OLLAMA_URL || "http://localhost:11434";
  const _MODEL  = process.env.LLM_MODEL  || "qwen3:8b";
  axios.post(`${_OLLAMA}/api/generate`, { model: _MODEL, prompt: "", stream: false, keep_alive: "1h" }, { timeout: 30000 })
    .then(() => console.log(`[warmup] ${_MODEL} loaded into Ollama memory`))
    .catch((e) => console.warn(`[warmup] model pre-warm failed: ${e.message}`));
});


// ── Priority action scheduler ─────────────────────────────────────────────────
setInterval(() => {
  processNextAction().catch(err => {
    console.error("[PRIORITY SCHEDULER] processNextAction failed:", err.message);
  });
}, 5000);

// ── Threads activity loop ─────────────────────────────────────────────────────
if (process.env.THREADS_PAUSED === "1") {
  console.log("[THREADS] THREADS_PAUSED=1 — Threads activity loop disabled. Telegram-only mode.");
} else {
  getThreadsContext().catch(err => {
    console.error("[THREADS EXECUTOR] preload failed:", err.message);
  });
  startActivityLoop();
}

// Telegram and Discord are started as separate pm2 processes.
// See ecosystem.config.js — do NOT require them here.
