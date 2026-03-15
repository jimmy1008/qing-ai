"use strict";
/**
 * phone_ws.js
 *
 * WebSocket handler for iPhone PWA (/ws/phone).
 *
 * Protocol:
 *   Client → Server:
 *     JSON { type:"text", text } — text input → AI → TTS
 *     JSON { type:"ping" }       — keepalive
 *
 *   Server → Client:
 *     { type:"thinking" }                      — AI is processing
 *     { type:"reply", text, audio:base64 }     — AI reply + TTS MP3
 *     { type:"initiate", text, audio:base64 }  — 晴 proactively speaks
 *     { type:"error", message }
 *     { type:"pong" }
 *
 * Memory: every turn goes through the full orchestrator (processEvent),
 *         so memory is written exactly like Telegram/chat conversations.
 */

const WebSocket = require("ws");
const { processEvent } = require("../../ai/orchestrator");
const { synthesize }   = require("../../ai/tts_engine");
const { registerPhone, unregisterPhone } = require("./phone_push");

const PHONE_OWNER_ID   = process.env.PHONE_OWNER_USER_ID || "phone_owner";
const REPLY_TIMEOUT_MS = 90000;

// ── Single conversation turn ──────────────────────────────────────────────────

async function handleTurn(ws, userText, sessionHistory) {
  if (!userText) return;
  if (ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({ type: "thinking" }));

  const event = {
    type:      "message",
    text:      userText,
    content:   userText,
    userId:    PHONE_OWNER_ID,
    username:  "user",
    connector: "phone",
    isPrivate: true,
    channel:   "private",
    role:      "developer",
  };

  let result;
  try {
    result = await Promise.race([
      processEvent(event),
      new Promise((_, rej) => setTimeout(() => rej(new Error("reply timeout")), REPLY_TIMEOUT_MS)),
    ]);
  } catch (err) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "error", message: err.message }));
    }
    return;
  }

  const replyText = String(result?.reply || "").trim();
  if (!replyText) return;

  sessionHistory.push({ role: "user", text: userText });
  sessionHistory.push({ role: "bot",  text: replyText });
  if (sessionHistory.length > 40) sessionHistory.splice(0, 4);

  let audioBuffer;
  try {
    audioBuffer = await synthesize(replyText);
  } catch (err) {
    console.error("[phone] TTS error:", err.message);
    audioBuffer = Buffer.alloc(0);
  }

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type:  "reply",
      text:  replyText,
      audio: audioBuffer.length > 0 ? audioBuffer.toString("base64") : null,
    }));
  }
}

// ── WebSocket server setup ────────────────────────────────────────────────────

function setupPhoneWS(server) {
  // noServer: true — upgrade routing is handled manually in server.js
  // This prevents conflicts when multiple WebSocket servers share one HTTP server.
  const wss = new WebSocket.Server({ noServer: true });

  // Server-side heartbeat: ping every 20s, close if no pong within 10s
  const PING_INTERVAL_MS = 20000;
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws._phoneAlive === false) { ws.terminate(); return; }
      ws._phoneAlive = false;
      ws.ping();
    });
  }, PING_INTERVAL_MS);

  wss.on("connection", (ws, req) => {
    const sessionHistory = [];
    ws._phoneAlive = true;
    ws.on("pong", () => { ws._phoneAlive = true; });

    registerPhone(ws, sessionHistory);
    console.log("[phone] connected from", req.socket.remoteAddress);

    ws.on("message", async (raw, isBinary) => {
      if (isBinary) return; // ignore binary frames

      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === "text" && msg.text) {
        await handleTurn(ws, String(msg.text), sessionHistory);
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    });

    ws.on("close", () => {
      unregisterPhone(ws);
      console.log("[phone] disconnected");
    });

    ws.on("error", (err) => {
      console.error("[phone] ws error:", err.message);
      unregisterPhone(ws);
    });
  });

  return wss; // caller uses this to route HTTP upgrade events
}

module.exports = { setupPhoneWS };
