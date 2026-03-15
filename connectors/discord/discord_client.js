"use strict";
/**
 * discord_client.js  —  晴的 Discord selfbot connector
 *
 * 文字：
 *   DM (任何人) → 全 AI pipeline → 回覆
 *   Guild → 被 @mention 或 owner 發訊息 → 回覆
 *
 * 語音：
 *   DM 通話    — callCreate 事件 → 自動接聽 → TTS 語音回覆
 *   Guild 語音 — owner 進頻道 → 跟進 → TTS 語音回覆
 *   owner 離開 → 晴離開
 *
 * 記憶：
 *   Discord owner ID → 連結到 Telegram globalKey，完全共用記憶
 */

// ── ffmpeg path (for prism-media audio playback) ─────────────────────────────
const ffmpegPath = require("ffmpeg-static");
process.env.FFMPEG_PATH = ffmpegPath;

const { Client }  = require("discord.js-selfbot-v13");
const { Readable } = require("stream");
const path         = require("path");
const fs           = require("fs");
const os           = require("os");

const { processEvent }                      = require("../../ai/orchestrator");
const { synthesize }                        = require("../../ai/tts_engine");
const { getOrCreateGlobalUserKey, isKnownUser } = require("../../ai/global_identity_map");
const { logConnectorReady, appendEvent }    = require("../../ai/system_event_log");
const { processReaction }                   = require("../../ai/feedback_receptor");
const { maybeSamplePattern }               = require("../../ai/social_pattern_memory");

// ── Known guilds (persistent, for new-guild detection) ───────────────────────
const KNOWN_GUILDS_PATH = require("path").join(__dirname, "../../memory/known_guilds.json");
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

// ── In-memory guild message registry (for group context injection) ────────────
const MAX_GUILD_MSGS = 10;
const guildMsgRegistry = new Map(); // channelId → [{ text, username, ts }]
function registerGuildMessage(channelId, { text = "", username = null } = {}) {
  const arr = guildMsgRegistry.get(channelId) || [];
  arr.push({ text, username, ts: Date.now() });
  if (arr.length > MAX_GUILD_MSGS) arr.shift();
  guildMsgRegistry.set(channelId, arr);
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID      = process.env.DISCORD_OWNER_ID;
const SELF_ID       = process.env.DISCORD_SELF_ID;
const OWNER_TG_ID   = process.env.DEV_TELEGRAM_ID;

const REPLY_COOLDOWN_MS = 2500;
const lastReply = new Map(); // channelId → timestamp

// ── In-memory reaction tracker (Discord sent messages) ────────────────────────
const MAX_TRACKED_REPLIES = 500;
const TRACKED_TTL_MS      = 7 * 24 * 60 * 60 * 1000; // 7 days
const _trackedReplies     = new Map(); // messageId → { userId, replyText, userText, ts }

function _trackReply(messageId, context) {
  if (!messageId) return;
  _trackedReplies.set(String(messageId), { ...context, ts: Date.now() });
  if (_trackedReplies.size > MAX_TRACKED_REPLIES) {
    _trackedReplies.delete(_trackedReplies.keys().next().value);
  }
}

function _lookupReply(messageId) {
  const entry = _trackedReplies.get(String(messageId));
  if (!entry) return null;
  if (Date.now() - entry.ts > TRACKED_TTL_MS) { _trackedReplies.delete(String(messageId)); return null; }
  return entry;
}

// ── Link Discord owner → Telegram global identity ────────────────────────────
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
      // Also fix the "unknown:OWNER_ID" key if it exists
      const unknownKey = `unknown:${OWNER_ID}`;
      if (store.platformUserMap[unknownKey]) store.platformUserMap[unknownKey] = globalKey;
      fs.writeFileSync(MAP_PATH, JSON.stringify(store, null, 2));
      console.log(`[discord] linked ${dcKey} → ${globalKey} (Telegram memory shared)`);
    }
  } catch (e) {
    console.warn("[discord] identity link failed:", e.message);
  }
}

// ── AI turn ──────────────────────────────────────────────────────────────────
async function handleTurn(userId, username, text, opts = {}) {
  const { isPrivate = true, channelId = "dm", extraMeta = {} } = opts;
  getOrCreateGlobalUserKey({ platform: "discord", userId, username });
  const result = await processEvent({
    type:      "message",
    text, content: text,
    userId, username,
    connector: "discord",
    isPrivate,
    channel:   isPrivate ? "private" : (channelId || "group"),
    chatId:    channelId,
    role:      userId === OWNER_ID ? "developer" : "user",
    meta:      extraMeta,
  });
  return String(result?.reply || "").trim();
}

// ── Play TTS via selfbot voice connection ────────────────────────────────────
async function speakVia(connection, text) {
  if (!connection || !text) return;
  try {
    const buf = await synthesize(text);
    if (!buf || buf.length === 0) return;
    // Write to temp file — prism FFmpeg reads file path for best compatibility
    const tmp = path.join(os.tmpdir(), `qing_tts_${Date.now()}.mp3`);
    fs.writeFileSync(tmp, buf);
    const dispatcher = connection.player.playUnknown(tmp, { volume: 1 });
    dispatcher?.once("finish", () => {
      try { fs.unlinkSync(tmp); } catch {}
    });
    dispatcher?.once("error", () => {
      try { fs.unlinkSync(tmp); } catch {}
    });
  } catch (e) {
    console.error("[discord] TTS speak error:", e.message);
  }
}

// ── Send text reply (2000-char chunks) — returns last sent message ───────────
async function sendReply(channel, text) {
  if (!text) return null;
  let lastMsg = null;
  for (let i = 0; i < text.length; i += 1900) {
    lastMsg = await channel.send(text.slice(i, i + 1900)).catch((e) => {
      console.error("[discord] send error:", e.message);
      return null;
    });
  }
  return lastMsg;
}

// ── Cooldown guard ───────────────────────────────────────────────────────────
function canReply(channelId) {
  const last = lastReply.get(channelId) || 0;
  if (Date.now() - last < REPLY_COOLDOWN_MS) return false;
  lastReply.set(channelId, Date.now());
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────────
function startDiscordClient() {
  if (!DISCORD_TOKEN) {
    console.warn("[discord] DISCORD_TOKEN not set — skipping");
    return;
  }

  linkOwnerIdentity();

  const client = new Client({ checkUpdate: false });

  // active voice connection (one at a time for selfbot)
  let activeConn = null;

  client.on("ready", () => {
    console.log(`[discord] logged in as ${client.user.tag}`);
    logConnectorReady("discord", `帳號：${client.user.tag}`);
  });

  // ── DM voice call incoming ────────────────────────────────────────────────
  client.on("callCreate", async (call) => {
    const channel = call.channel;
    if (!channel) return;
    console.log(`[discord] incoming call — answering in 1.5s`);
    await new Promise((r) => setTimeout(r, 1500));

    // Retry up to 2 times — voice WebSocket handshake sometimes needs a second attempt
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        activeConn = await client.voice.joinChannel(channel, { selfDeaf: false, selfMute: false });
        console.log(`[discord] answered DM call (attempt ${attempt})`);
        activeConn.once("disconnect", () => {
          activeConn = null;
          console.log("[discord] call connection dropped");
        });
        activeConn.once("closing", () => { activeConn = null; });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`[discord] call join attempt ${attempt} failed: ${e.message}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (lastErr) console.error("[discord] failed to answer call after retries:", lastErr.message);
  });

  // ── DM call ended (caller hung up) ────────────────────────────────────────
  client.on("callDelete", () => {
    if (activeConn) {
      try { activeConn.disconnect(); } catch {}
      activeConn = null;
      console.log("[discord] call ended, disconnected");
    }
  });

  // callUpdate: ringing array empty = everyone left / hung up
  client.on("callUpdate", (call) => {
    if (!activeConn) return;
    if (call._ringing && call._ringing.length === 0 && call.channel) {
      // Check if anyone else (non-self) is still in the call voice state
      const channel = call.channel;
      const othersInCall = channel.voiceUsers?.filter((u) => u.id !== SELF_ID)?.size ?? 1;
      if (othersInCall === 0) {
        try { activeConn.disconnect(); } catch {}
        activeConn = null;
        console.log("[discord] all callers left, disconnected");
      }
    }
  });

  // ── Voice state: follow owner (guild) + detect DM call hang-up ───────────
  client.on("voiceStateUpdate", async (oldState, newState) => {
    const memberId = newState.member?.id || oldState.member?.id
                  || newState.id || oldState.id; // DM calls use user id directly
    if (memberId !== OWNER_ID) return;

    const guildId      = newState.guild?.id || oldState.guild?.id;
    const ownerLeft    = oldState.channelId && !newState.channelId;
    const ownerJoined  = newState.channelId && oldState.channelId !== newState.channelId;

    if (ownerLeft) {
      // Owner left any voice channel (guild or DM call) → disconnect
      if (activeConn) {
        try { activeConn.disconnect(); } catch {}
        try { client.voice.connection?.disconnect(); } catch {}
        activeConn = null;
        console.log(`[discord] owner left voice/call, disconnected`);
      }
      return;
    }

    if (ownerJoined) {
      const channel = newState.channel;
      if (!channel) return;
      try {
        if (activeConn) { try { activeConn.disconnect(); } catch {} }
        activeConn = await client.voice.joinChannel(channel, { selfDeaf: false, selfMute: false });
        console.log(`[discord] joined guild voice: ${channel.name}`);
        activeConn.once("disconnect", () => { activeConn = null; });
        activeConn.once("closing",    () => { activeConn = null; });
      } catch (e) {
        console.error("[discord] guild voice join error:", e.message);
      }
    }
  });

  // ── Text messages ─────────────────────────────────────────────────────────
  client.on("messageCreate", async (msg) => {
    if (msg.author.id === SELF_ID) return;
    if (msg.author.bot)            return;

    const text       = msg.content.trim();
    if (!text) return;

    const isDM       = !msg.guild;
    const isOwner    = msg.author.id === OWNER_ID;
    const mentioned  = msg.mentions.users.has(SELF_ID);

    if (!isDM && !isOwner && !mentioned) return;
    if (!canReply(msg.channelId)) return;

    const cleanText = text.replace(/<@!?\d+>/g, "").trim() || text;

    // P1 — !notify command (owner only)
    if (isOwner && cleanText.startsWith("!notify ")) {
      const note = cleanText.slice(8).trim();
      if (note) {
        appendEvent("new_feature", note);
        await msg.channel.send("✓ 記下來了").catch(() => {});
      }
      return;
    }

    // Track guild messages for group context
    if (!isDM) {
      registerGuildMessage(msg.channelId, { text: cleanText, username: msg.author.username });
      maybeSamplePattern(`dc_${msg.channelId}`, guildMsgRegistry.get(msg.channelId) || []);
    }

    // P0 — build extra meta
    const extraMeta = { groupId: !isDM ? `dc_${msg.channelId}` : null };
    const userRef = { platform: "discord", userId: msg.author.id, username: msg.author.username };
    if (!isOwner && !isKnownUser(userRef)) {
      extraMeta.firstMeeting = true;
      extraMeta.firstMeetingName = msg.author.username || null;
    }
    if (!isDM && msg.guildId && checkAndMarkNewGuild(msg.guildId, msg.guild?.name)) {
      extraMeta.newGroup = true;
      extraMeta.newGroupTitle = msg.guild?.name || null;
    }
    // P2 — inject recent guild messages (exclude the current one)
    if (!isDM) {
      const recent = (guildMsgRegistry.get(msg.channelId) || []).slice(0, -1).slice(-6);
      if (recent.length > 0) {
        extraMeta.groupRecentMessages = recent.map(m => `${m.username || "?"}：${m.text}`).join("\n");
      }
    }

    try {
      if (msg.channel.sendTyping) await msg.channel.sendTyping().catch(() => {});
      const reply = await handleTurn(
        msg.author.id, msg.author.username, cleanText,
        { isPrivate: isDM, channelId: msg.channelId, extraMeta },
      );
      if (!reply) return;

      const sentMsg = await sendReply(msg.channel, reply);

      // Track for reaction feedback
      if (sentMsg?.id) {
        _trackReply(sentMsg.id, { userId: msg.author.id, replyText: reply, userText: cleanText });
      }

      // Speak TTS if in active voice call/channel
      if (activeConn) speakVia(activeConn, reply).catch(() => {});

    } catch (e) {
      console.error("[discord] message handler error:", e.message);
    }
  });

  // ── Reaction feedback ──────────────────────────────────────────────────────
  // Fires when any user reacts to a message. Only cares about reactions on
  // tracked AI replies; ignores self-reactions.
  client.on("messageReactionAdd", (reaction, user) => {
    try {
      if (!user || user.id === SELF_ID) return;
      const msgId = reaction?.message?.id || reaction?.messageId;
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

  client.login(DISCORD_TOKEN).catch((e) =>
    console.error("[discord] login failed:", e.message)
  );

  return client;
}

module.exports = { startDiscordClient };
