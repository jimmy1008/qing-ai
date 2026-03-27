"use strict";

// ffmpeg path (for prism-media audio playback)
const ffmpegPath = require("ffmpeg-static");
process.env.FFMPEG_PATH = ffmpegPath;

const { Client } = require("discord.js-selfbot-v13");
const path       = require("path");
const fs         = require("fs");
const os         = require("os");
const axios      = require("axios");

const { processEvent }                          = require("../../ai/orchestrator");
const { synthesize }                            = require("../../ai/tts_engine");
const { ingestEvent }                           = require("../../ai/memory_bus");
const { getOrCreateGlobalUserKey, isKnownUser } = require("../../ai/global_identity_map");
const { logConnectorReady, logRestart, appendEvent } = require("../../ai/system_event_log");
const { processReaction }                       = require("../../ai/feedback_receptor");
const { maybeSamplePattern }                    = require("../../ai/social_pattern_memory");
const { maybeSampleExpressions }                = require("../../ai/modules/expression_learner");
const { maybeSampleTopics }                     = require("../../ai/modules/topic_interest");
const { startConnectorHeartbeat }               = require("../../ai/connector_heartbeat_client");
const { detectSearchIntent, search, getSearchingPhrase } = require("../../ai/web_search");
const { describeImage }                         = require("../../ai/image_describer");
const { registerDcGuildMessage, registerDcDmUser, guildChannelRegistry } = require("./dc_chat_registry");
const { startDiscordProactiveScheduler }        = require("../../ai/discord_proactive_scheduler");

// ── Constants ──────────────────────────────────────────────────────────────────

const DISCORD_TOKEN      = process.env.DISCORD_TOKEN;
const OWNER_ID           = process.env.DISCORD_OWNER_ID;
const SELF_ID            = process.env.DISCORD_SELF_ID;
const OWNER_TG_ID        = process.env.DEV_TELEGRAM_ID;
const REPLY_COOLDOWN_MS  = 2500;
const AI_HARD_TIMEOUT_MS = 90000; // match TG
const BATCH_DELAY_MS     = 3500;  // match TG

// ── Logging ────────────────────────────────────────────────────────────────────

const logPath = path.join(__dirname, "../../logs/connector.log");
fs.mkdirSync(path.dirname(logPath), { recursive: true });
function writeLog(stage, data = {}) {
  fs.appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), connector: "discord", stage, ...data })}\n`);
}

// ── Known guilds (new-guild detection) ────────────────────────────────────────

const KNOWN_GUILDS_PATH = path.join(__dirname, "../../memory/known_guilds.json");
function loadKnownGuilds() {
  try { if (fs.existsSync(KNOWN_GUILDS_PATH)) return JSON.parse(fs.readFileSync(KNOWN_GUILDS_PATH, "utf-8")); } catch {}
  return {};
}
const knownGuilds = loadKnownGuilds();
function checkAndMarkNewGuild(guildId, guildName) {
  const key = String(guildId);
  if (knownGuilds[key]) return false;
  knownGuilds[key] = { ts: Date.now(), name: guildName || key };
  fs.writeFileSync(KNOWN_GUILDS_PATH, JSON.stringify(knownGuilds, null, 2), "utf-8");
  return true;
}

// Guild message registry is now in dc_chat_registry.js (imported above)

// ── Reaction tracker ──────────────────────────────────────────────────────────

const MAX_TRACKED_REPLIES = 500;
const TRACKED_TTL_MS      = 7 * 24 * 60 * 60 * 1000; // 7 days
const _trackedReplies     = new Map();

function _trackReply(messageId, context) {
  if (!messageId) return;
  _trackedReplies.set(String(messageId), { ...context, ts: Date.now() });
  if (_trackedReplies.size > MAX_TRACKED_REPLIES)
    _trackedReplies.delete(_trackedReplies.keys().next().value);
}

function _lookupReply(messageId) {
  const entry = _trackedReplies.get(String(messageId));
  if (!entry) return null;
  if (Date.now() - entry.ts > TRACKED_TTL_MS) { _trackedReplies.delete(String(messageId)); return null; }
  return entry;
}

// ── Reply cooldown ─────────────────────────────────────────────────────────────

const lastReply = new Map();
function canReply(channelId) {
  const last = lastReply.get(channelId) || 0;
  if (Date.now() - last < REPLY_COOLDOWN_MS) return false;
  lastReply.set(channelId, Date.now());
  return true;
}

// ── DM dispatch lock + pending queue (matches TG) ─────────────────────────────

const _dispatchingDMs = new Set();
const _pendingDMQueue = new Map(); // channelId → [{ userId, username, inputText, msg, opts }]

// ── DM message batching buffer (matches TG) ───────────────────────────────────

const _dmBuffer = new Map(); // channelId → { parts, lastMsg, userId, username, timer }

function bufferDMMessage(channelId, userId, username, inputText, msg) {
  const existing = _dmBuffer.get(channelId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.parts.push(inputText);
    existing.lastMsg = msg;
  } else {
    _dmBuffer.set(channelId, { parts: [inputText], lastMsg: msg, userId, username });
  }
  const entry = _dmBuffer.get(channelId);
  entry.timer = setTimeout(() => {
    _dmBuffer.delete(channelId);
    const combined = entry.parts.join("\n");
    dispatchToAI(entry.userId, entry.username, combined, entry.lastMsg, { isDM: true, channelId })
      .catch(e => console.error("[discord] buffer flush error:", e.message));
  }, BATCH_DELAY_MS);
}

// ── Split reply into segments for natural DM feel (matches TG) ────────────────

function splitReplyIntoSegments(text = "") {
  const t = String(text || "").trim();
  if (!t || t.length <= 45 || t.length > 160) return [t];
  const parts = t.split(/(?<=[。！？~～])\s*/).map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [t];
  if (parts.length === 2)
    return (parts[0].length >= 15 && parts[1].length >= 10) ? parts : [t];
  const mid = Math.ceil(parts.length / 2);
  const a = parts.slice(0, mid).join("");
  const b = parts.slice(mid).join("");
  return (a.length >= 15 && b.length >= 10) ? [a, b] : [t];
}

// ── Link Discord owner ↔ Telegram global identity ─────────────────────────────

function linkOwnerIdentity() {
  if (!OWNER_ID || !OWNER_TG_ID) return;
  const MAP_PATH = path.join(__dirname, "../../memory/platform_user_map.json");
  if (!fs.existsSync(MAP_PATH)) return;
  try {
    const store     = JSON.parse(fs.readFileSync(MAP_PATH, "utf-8"));
    const tgKey     = `telegram:${OWNER_TG_ID}`;
    const dcKey     = `discord:${OWNER_ID}`;
    const globalKey = store.platformUserMap[tgKey];
    if (globalKey && store.platformUserMap[dcKey] !== globalKey) {
      store.platformUserMap[dcKey] = globalKey;
      const unknownKey = `unknown:${OWNER_ID}`;
      if (store.platformUserMap[unknownKey]) store.platformUserMap[unknownKey] = globalKey;
      fs.writeFileSync(MAP_PATH, JSON.stringify(store, null, 2));
      console.log(`[discord] linked ${dcKey} → ${globalKey} (Telegram memory shared)`);
    }
  } catch (e) {
    console.warn("[discord] identity link failed:", e.message);
  }
}

// ── TTS via selfbot voice connection ──────────────────────────────────────────

let _activeConn = null; // module-level for buffer/queue access

async function speakVia(connection, text) {
  if (!connection || !text) return;
  try {
    const buf = await synthesize(text);
    if (!buf || buf.length === 0) return;
    const tmp = path.join(os.tmpdir(), `qing_tts_${Date.now()}.mp3`);
    fs.writeFileSync(tmp, buf);
    const dispatcher = connection.player.playUnknown(tmp, { volume: 1 });
    dispatcher?.once("finish", () => { try { fs.unlinkSync(tmp); } catch {} });
    dispatcher?.once("error",  () => { try { fs.unlinkSync(tmp); } catch {} });
  } catch (e) {
    console.error("[discord] TTS speak error:", e.message);
  }
}

// ── Send reply (segmented for DM, chunked for guild) ─────────────────────────

async function sendReply(channel, text, { isDM = false } = {}) {
  if (!text) return null;
  let lastMsg = null;

  if (isDM) {
    const segments = splitReplyIntoSegments(text);
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        if (channel.sendTyping) channel.sendTyping().catch(() => {});
        const delay = Math.max(500, Math.min(segments[i].length * 30, 2500));
        await new Promise(r => setTimeout(r, delay));
      }
      lastMsg = await channel.send(segments[i]).catch(e => {
        console.error("[discord] send error:", e.message);
        return null;
      });
    }
  } else {
    for (let i = 0; i < text.length; i += 1900) {
      lastMsg = await channel.send(text.slice(i, i + 1900)).catch(e => {
        console.error("[discord] send error:", e.message);
        return null;
      });
    }
  }
  return lastMsg;
}

// ── Core AI dispatch ──────────────────────────────────────────────────────────
// Full parity with TG's dispatchToAI:
//   DM lock → ingest incoming → build event w/ full meta →
//   attachment/image → quoted context → absence → web search →
//   90s timeout → processEvent → split send → ingest outgoing → TTS → log

async function dispatchToAI(userId, username, inputText, msg, opts = {}) {
  const { isDM = true, channelId = "dm", mentioned = false } = opts;
  const channel = msg.channel;
  const isOwner = userId === OWNER_ID;

  // DM lock: queue if already processing this DM channel
  if (isDM && _dispatchingDMs.has(channelId)) {
    const q = _pendingDMQueue.get(channelId) || [];
    q.push({ userId, username, inputText, msg, opts });
    _pendingDMQueue.set(channelId, q);
    writeLog("dm_queued", { channelId, queueLen: q.length });
    return;
  }
  if (isDM) _dispatchingDMs.add(channelId);

  // Typing keepalive — Discord indicator fades after ~10s, refresh every 8s
  if (channel.sendTyping) channel.sendTyping().catch(() => {});
  const typingInterval = setInterval(() => {
    if (channel.sendTyping) channel.sendTyping().catch(() => {});
  }, 8000);

  try {
    // Ingest incoming event into memory bus
    ingestEvent({
      platform:    "discord",
      channelType: isDM ? "private" : "group",
      chatId:      channelId,
      userId,
      senderId:    userId,
      senderName:  username,
      username,
      text:        inputText,
      timestamp:   Date.now(),
      direction:   "incoming",
      role:        isOwner ? "developer" : "public_user",
      eventType:   "message",
      meaningful:  true,
    });

    writeLog("pipeline_dispatch", { channelId, isDM, userId, username, text: inputText });

    // Build extra meta
    const extraMeta = {
      groupId:                    !isDM ? `dc_${channelId}` : null,
      skipConversationBufferWrite: true, // ingestEvent already handles memory
    };

    // First meeting detection
    const userRef = { platform: "discord", userId, username };
    if (!isOwner && !isKnownUser(userRef)) {
      extraMeta.firstMeeting     = true;
      extraMeta.firstMeetingName = username || null;
    }

    // New guild detection
    if (!isDM && msg.guildId && checkAndMarkNewGuild(msg.guildId, msg.guild?.name)) {
      extraMeta.newGroup      = true;
      extraMeta.newGroupTitle = msg.guild?.name || null;
    }

    // Recent guild messages context (exclude current message + bots)
    if (!isDM) {
      const selfUsername = client?.user?.username;
      const recent = (guildChannelRegistry.get(channelId)?.recentMessages || [])
        .slice(0, -1)
        .slice(-6)
        .filter(m => m.username !== selfUsername);  // exclude own messages
      if (recent.length > 0)
        // Plain text only — no "Username：" prefix to prevent model learning that output format
        extraMeta.groupRecentMessages = recent.map(m => m.text).join("\n");
    }

    // Long absence detection (private chat only, ≥3 days)
    if (isDM && !isOwner) {
      try {
        const { makeSessionKey, getSession } = require("../../ai/memory/working_memory");
        const sessionKey = makeSessionKey({ connector: "discord", isPrivate: true, userId });
        const turns = getSession(sessionKey);
        if (turns.length > 0) {
          const lastTs    = turns[turns.length - 1]?.ts || 0;
          const daysSince = (Date.now() - lastTs) / (1000 * 60 * 60 * 24);
          if (daysSince >= 3) extraMeta.absenceDays = Math.floor(daysSince);
        }
      } catch { /* ignore */ }
    }

    const event = {
      type:      "message",
      text:      inputText,
      content:   inputText,
      userId,
      username,
      connector: "discord",
      isPrivate: isDM,
      channel:   isDM ? "private" : (channelId || "group"),
      chatId:    channelId,
      role:      isOwner ? "developer" : "user",
      meta:      extraMeta,
    };

    // Hard 90s timeout (same as TG)
    let aiTimeoutHandle;
    const aiTimeoutPromise = new Promise((_, reject) => {
      aiTimeoutHandle = setTimeout(() => reject(new Error("ai_hard_timeout")), AI_HARD_TIMEOUT_MS);
    });

    // Web search — DM always; guild only when @mentioned (isOwner already gated above)
    if (isDM || (!isDM && mentioned)) {
      const searchIntent = detectSearchIntent(inputText);
      if (searchIntent.needsSearch) {
        const searchingMsg = getSearchingPhrase();
        await channel.send(searchingMsg).catch(() => {});
        const delay = 10000 + Math.random() * 20000;
        const [snippets] = await Promise.all([
          search(searchIntent.query),
          new Promise(r => setTimeout(r, delay)),
        ]);
        if (snippets && snippets.trim()) {
          const augmented = `[網路搜尋結果]\n${snippets.trim()}\n\n[原始訊息] ${inputText}`;
          event.text    = augmented;
          event.content = augmented;
        }
      }
    }

    let result;
    try {
      result = await Promise.race([processEvent(event), aiTimeoutPromise]);
    } catch (innerErr) {
      clearTimeout(aiTimeoutHandle);
      if (innerErr.message === "ai_hard_timeout") {
        clearInterval(typingInterval);
        writeLog("ai_timeout", { channelId, isDM, userId });
        return; // silent abort, matches TG behaviour
      }
      throw innerErr;
    }
    clearTimeout(aiTimeoutHandle);

    writeLog("reply", {
      channelId, isDM, userId,
      skipped:   Boolean(result.skipped),
      intent:    result.telemetry?.intent || "none",
      model:     result.telemetry?.model  || null,
    });

    if (result.skipped || !result.reply) {
      clearInterval(typingInterval);
      return;
    }

    clearInterval(typingInterval);

    const replyText = result.reply;
    const sentMsg   = await sendReply(channel, replyText, { isDM });

    // Track for reaction feedback
    if (sentMsg?.id)
      _trackReply(sentMsg.id, { userId, replyText, userText: inputText });

    // Record reply for topic continuation detection (group only)
    if (!isDM) {
      const { recordBotReply } = require("../../ai/gate_layer");
      recordBotReply(String(channelId), replyText);
    }

    // Ingest outgoing event into memory bus
    ingestEvent({
      platform:    "discord",
      channelType: isDM ? "private" : "group",
      chatId:      channelId,
      userId,
      username,
      text:        replyText,
      timestamp:   Date.now(),
      direction:   "outgoing",
      role:        isOwner ? "developer" : "public_user",
      eventType:   "reply",
      meaningful:  true,
    });

    // ── Chart screenshot: send after text reply if requested ─────────────────
    if (result.chart) {
      try {
        const { openChart } = require("../../ai/modules/trading/chart_viewer");
        const { screenshotB64 } = await openChart(result.chart.asset, result.chart.interval);
        const TF_LABEL = { "240": "4H", "60": "1H", "15": "15M", "5": "5M" };
        const caption  = `${result.chart.asset}/USDT ${TF_LABEL[result.chart.interval] || result.chart.interval}`;
        await channel.send({
          content: caption,
          files: [{ attachment: Buffer.from(screenshotB64, "base64"), name: "chart.jpg" }],
        });
      } catch (err) {
        console.warn("[discord] chart screenshot failed:", err.message);
      }
    }

    // TTS if in active voice call/channel
    if (_activeConn) speakVia(_activeConn, replyText).catch(() => {});

    writeLog("send_success", { channelId, isDM, userId, messageId: sentMsg?.id || null });

  } catch (err) {
    clearInterval(typingInterval);
    writeLog("send_error", { message: err.message, channelId, isDM, userId });
    await channel.send("抱歉，剛才出了點問題，你可以再試一次。").catch(() => {});
  } finally {
    // Release DM lock and flush queued messages as combined turn
    if (isDM) {
      _dispatchingDMs.delete(channelId);
      const queued = _pendingDMQueue.get(channelId);
      if (queued && queued.length > 0) {
        _pendingDMQueue.delete(channelId);
        const combined   = queued.map(q => q.inputText).join("\n");
        const lastEntry  = queued[queued.length - 1];
        writeLog("dm_queue_flush", { channelId, count: queued.length });
        dispatchToAI(lastEntry.userId, lastEntry.username, combined, lastEntry.msg, lastEntry.opts)
          .catch(() => {});
      }
    }
  }
}

// ── Main client ───────────────────────────────────────────────────────────────

function startDiscordClient() {
  if (!DISCORD_TOKEN) {
    console.warn("[discord] DISCORD_TOKEN not set — skipping");
    return;
  }

  linkOwnerIdentity();

  const client = new Client({ checkUpdate: false });

  client.on("ready", () => {
    console.log(`[discord] logged in as ${client.user.tag}`);
    logConnectorReady("discord", `帳號：${client.user.tag}`);
    logRestart("discord", `帳號：${client.user.tag}`);
    startConnectorHeartbeat("discord", () => ({ selfTag: client.user.tag }));
    startDiscordProactiveScheduler(client);
  });

  // ── DM voice call incoming ─────────────────────────────────────────────────
  client.on("callCreate", async (call) => {
    const ch = call.channel;
    if (!ch) return;
    console.log("[discord] incoming call — answering in 1.5s");
    await new Promise(r => setTimeout(r, 1500));

    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        _activeConn = await client.voice.joinChannel(ch, { selfDeaf: false, selfMute: false });
        console.log(`[discord] answered DM call (attempt ${attempt})`);
        _activeConn.once("disconnect", () => { _activeConn = null; console.log("[discord] call dropped"); });
        _activeConn.once("closing",    () => { _activeConn = null; });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`[discord] call join attempt ${attempt} failed: ${e.message}`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (lastErr) console.error("[discord] failed to answer call after retries:", lastErr.message);
  });

  client.on("callDelete", () => {
    if (_activeConn) {
      try { _activeConn.disconnect(); } catch {}
      _activeConn = null;
      console.log("[discord] call ended, disconnected");
    }
  });

  client.on("callUpdate", (call) => {
    if (!_activeConn) return;
    if (call._ringing && call._ringing.length === 0 && call.channel) {
      const othersInCall = call.channel.voiceUsers?.filter(u => u.id !== SELF_ID)?.size ?? 1;
      if (othersInCall === 0) {
        try { _activeConn.disconnect(); } catch {}
        _activeConn = null;
        console.log("[discord] all callers left, disconnected");
      }
    }
  });

  // ── Voice state: follow owner into guild voice ─────────────────────────────
  client.on("voiceStateUpdate", async (oldState, newState) => {
    const memberId = newState.member?.id || oldState.member?.id || newState.id || oldState.id;
    if (memberId !== OWNER_ID) return;

    const ownerLeft   = oldState.channelId && !newState.channelId;
    const ownerJoined = newState.channelId && oldState.channelId !== newState.channelId;

    if (ownerLeft) {
      if (_activeConn) {
        try { _activeConn.disconnect(); } catch {}
        try { client.voice.connection?.disconnect(); } catch {}
        _activeConn = null;
        console.log("[discord] owner left voice/call, disconnected");
      }
      return;
    }

    if (ownerJoined) {
      const ch = newState.channel;
      if (!ch) return;
      try {
        if (_activeConn) { try { _activeConn.disconnect(); } catch {} }
        _activeConn = await client.voice.joinChannel(ch, { selfDeaf: false, selfMute: false });
        console.log(`[discord] joined guild voice: ${ch.name}`);
        _activeConn.once("disconnect", () => { _activeConn = null; });
        _activeConn.once("closing",    () => { _activeConn = null; });
      } catch (e) {
        console.error("[discord] guild voice join error:", e.message);
      }
    }
  });

  // ── Text messages ──────────────────────────────────────────────────────────
  client.on("messageCreate", async (msg) => {
    try {
      if (msg.author.id === SELF_ID) return;
      if (msg.author.bot)            return;

      const rawText = msg.content.trim();
      const isDM    = !msg.guild;
      const isOwner = msg.author.id === OWNER_ID;
      const mentioned = msg.mentions.users.has(SELF_ID);

      if (!isDM && !isOwner && !mentioned) return;
      if (!canReply(msg.channelId)) return;

      // Strip @mention and build base inputText
      let inputText = rawText.replace(/<@!?\d+>/g, "").trim() || rawText;

      // ── Image/attachment handling (always describe if image present, even with text) ──
      if (msg.attachments.size > 0) {
        const imgAttachment = [...msg.attachments.values()]
          .find(a => a.contentType?.startsWith("image/"));
        if (imgAttachment) {
          let imageDescription = null;
          try {
            const imgResp = await axios.get(imgAttachment.url, { responseType: "arraybuffer", timeout: 10000 });
            const base64  = Buffer.from(imgResp.data).toString("base64");
            imageDescription = await describeImage(base64, inputText);
          } catch { /* ignore */ }

          const imgPrefix = imageDescription
            ? `[圖片描述：${imageDescription}]`
            : "[使用者傳了一張圖片，但你無法描述其內容，請誠實說明。]";
          inputText = inputText ? `${imgPrefix}\n${inputText}` : imgPrefix;
        } else if (!inputText) {
          return; // non-image attachment with no text, skip
        }
      }

      if (!inputText) return;

      // ── !notify command (owner only) ───────────────────────────────────────
      if (isOwner && inputText.startsWith("!notify ")) {
        const note = inputText.slice(8).trim();
        if (note) {
          appendEvent("new_feature", note);
          await msg.channel.send("好，記下來了，她下次說話就會知道了。").catch(() => {});
        }
        return;
      }

      // ── Guild: register message for context + social pattern ───────────────
      if (!isDM) {
        registerDcGuildMessage(msg.channelId, {
          guildId: msg.guildId, guildName: msg.guild?.name,
          text: inputText, username: msg.author.username,
        });
        const _dcRecent = guildChannelRegistry.get(msg.channelId)?.recentMessages || [];
        maybeSamplePattern(`dc_${msg.channelId}`, _dcRecent);
        maybeSampleExpressions(`dc_${msg.channelId}`, _dcRecent);
        maybeSampleTopics(`dc_${msg.channelId}`, _dcRecent);
      }

      // ── DM: register user for proactive scheduler ─────────────────────────
      if (isDM && !isOwner) {
        const globalKey = getOrCreateGlobalUserKey({ platform: "discord", userId: msg.author.id, username: msg.author.username });
        registerDcDmUser(msg.channelId, { userId: msg.author.id, username: msg.author.username, globalKey });
      }

      writeLog("incoming", { channelId: msg.channelId, isDM, userId: msg.author.id, username: msg.author.username, text: inputText });

      // ── Guild gate: only respond to @mention / owner ───────────────────────
      if (!isDM && !isOwner && !mentioned) return;

      // ── Quoted message context injection (matches TG reply logic) ─────────
      if (msg.reference?.messageId) {
        try {
          const refMsg     = await msg.channel.messages.fetch(msg.reference.messageId);
          const quotedText = String(refMsg.content || "").trim().slice(0, 100);
          if (quotedText) {
            const isReplyToSelf = refMsg.author?.id === SELF_ID;
            if (isReplyToSelf) {
              inputText = `[你之前說的：${quotedText}」\n${inputText}`;
            } else {
              const quotedFrom = refMsg.author?.username || "對方";
              inputText = `[引用訊息 ——${quotedFrom} 說的：${quotedText}」\n${inputText}`;
            }
          }
        } catch { /* message may have been deleted */ }
      }

      const channelId = msg.channelId;

      // ── DM: buffer rapid messages, then dispatch ───────────────────────────
      if (isDM) {
        bufferDMMessage(channelId, msg.author.id, msg.author.username, inputText, msg);
        return;
      }

      // ── Guild: dispatch immediately (mentions already gated above) ─────────
      if (msg.channel.sendTyping) await msg.channel.sendTyping().catch(() => {});
      await dispatchToAI(msg.author.id, msg.author.username, inputText, msg, { isDM: false, channelId, mentioned });

    } catch (e) {
      writeLog("message_handler_error", { message: e.message, stack: e.stack?.slice(0, 300) });
      console.error("[discord] message handler error:", e.message);
    }
  });

  // ── Reaction feedback ──────────────────────────────────────────────────────
  client.on("messageReactionAdd", (reaction, user) => {
    try {
      if (!user || user.id === SELF_ID) return;
      const msgId = reaction?.message?.id;
      if (!msgId) return;
      const entry = _lookupReply(msgId);
      if (!entry) return;
      const emoji = reaction?.emoji?.name || "";
      if (!emoji) return;
      processReaction({
        platform:  "discord",
        userId:    user.id,
        replyText: entry.replyText,
        userText:  entry.userText,
        emoji,
      });
    } catch (e) {
      console.warn("[discord] reaction handler error:", e.message);
    }
  });

  client.login(DISCORD_TOKEN).catch(e =>
    console.error("[discord] login failed:", e.message)
  );

  return client;
}

module.exports = { startDiscordClient };
