const path = require("path");
const dotenv = require("dotenv");
const WebSocket = require("ws");

dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config({ path: path.join(__dirname, ".env.local"), override: true });

const express = require("express");
const { createOllamaClient, buildContext, generateVoiceReplyStream } = require("./ai/pipeline");
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

app.get("/trading", (_req, res) => res.sendFile(path.join(__dirname, "dashboard", "trading.html")));

// ── Start HTTP server ─────────────────────────────────────────────────────────
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

    const prompt = isInitiate
      ? (sessionHistory.length === 0
          ? "現在開始語音對話，你主動說第一句話，說你現在腦海裡浮現的任何事情，不要說「你好」之類的問候，直接說你想說的。"
          : "對話沉默了一段時間，你主動說一句話，可以繼續剛才的話題、說你突然想到的事，或者問對方一個具體的問題。說話自然，不解釋為什麼突然說話。")
      : userText;

    if (!isInitiate) ws.send(JSON.stringify({ type: "thinking" }));

    try {
      const context = buildContext(prompt, sessionHistory, {
        userId: null, username: null, role: "developer",
        connector: "voice", channel: "private", isPrivate: true,
      });

      let fullReply = "";
      let chunkIndex = 0;

      for await (const sentence of generateVoiceReplyStream(prompt, context, ollamaClient)) {
        fullReply += sentence;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "audio_chunk", text: sentence, index: chunkIndex++ }));
        }
      }

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

require("./connectors/telegram/bot");
