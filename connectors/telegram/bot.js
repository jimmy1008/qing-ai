const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { processEvent }             = require("../../ai/orchestrator");
const { createMultiModelClient }   = require("../../ai/llm_client");
const { detectSearchIntent, search, getSearchingPhrase } = require("../../ai/web_search");
const { ingestEvent } = require("../../ai/memory_bus");
const { describeImage } = require("../../ai/image_describer");
const { markGroupReplySent } = require("../../ai/group_presence_engine");
const { detectMention } = require("../../ai/mention_detector");
const developerConfig = require("../../config/developer_config");
const { registerGroupMessage, registerDmUser, checkAndMarkNewGroup } = require("./active_chat_registry");
const { getOrCreateGlobalUserKey, isKnownUser } = require("../../ai/global_identity_map");
const { startProactiveScheduler } = require("../../ai/telegram_proactive_scheduler");
const { trackReply, lookupReply }  = require("./reaction_tracker");
const { processReaction }          = require("../../ai/feedback_receptor");
const { logConnectorReady, logRestart, logCodeMod } = require("../../ai/system_event_log");
const { maybeSamplePattern }       = require("../../ai/social_pattern_memory");
const { maybeSampleExpressions }   = require("../../ai/modules/expression_learner");
const { maybeSampleTopics }        = require("../../ai/modules/topic_interest");
const { startConnectorHeartbeat }  = require("../../ai/connector_heartbeat_client");
const { shouldDispatch }           = require("../../ai/gate_layer");
const { getOrCreateCode }          = require("../../ai/user_code_registry");
const { getIdentityTruth }         = require("../../ai/memory_store");

const token = process.env.TG_TOKEN;
const ollamaClient = createMultiModelClient(); // still used by proactive scheduler

// ── Polling watchdog ────────────────────────────────────────────────────────
// If no incoming message arrives for 30 min, assume polling has silently died
// and exit so PM2 restarts the process cleanly.
let _lastActivity = Date.now();
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;   // check every 5 min
const WATCHDOG_THRESHOLD_MS = 30 * 60 * 1000; // alarm if silent for 30 min

setInterval(() => {
  if (Date.now() - _lastActivity > WATCHDOG_THRESHOLD_MS) {
    console.error("[bot] watchdog: no activity for 30 min — restarting");
    process.exit(1);
  }
}, WATCHDOG_INTERVAL_MS).unref();

/**
 * Split a reply into at most 2 message segments for natural texting feel.
 * Rules:
 * - Short (??45 chars) or long (> 160 chars) ??send as single message
 * - 2 clear sentences in 45??60 chars ??split into 2, only if both are substantial
 * - 3+ sentences ??merge into 2 balanced groups, each must be ??15 chars
 */
function splitReplyIntoSegments(text = "") {
  const t = String(text || "").trim();
  if (!t || t.length <= 45 || t.length > 160) return [t];

  const parts = t.split(/(?<=[。！？~～])\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [t];

  if (parts.length === 2) {
    return (parts[0].length >= 15 && parts[1].length >= 10) ? parts : [t];
  }

  // 3+ parts: merge into 2 balanced groups
  const mid = Math.ceil(parts.length / 2);
  const a = parts.slice(0, mid).join("");
  const b = parts.slice(mid).join("");
  return (a.length >= 15 && b.length >= 10) ? [a, b] : [t];
}

if (!token) {
  console.error("Missing TG_TOKEN");
  process.exit(1);
}

const logPath = path.join(__dirname, "../../logs/connector.log");
fs.mkdirSync(path.dirname(logPath), { recursive: true });

function writeLog(stage, data = {}) {
  fs.appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), connector: "telegram", stage, ...data })}\n`);
}

const bot = new TelegramBot(token, {
  polling: {
    params: {
      allowed_updates: [
        "message", "edited_message", "channel_post",
        "message_reaction", "message_reaction_count",
      ],
    },
  },
});
const RETRYABLE_TELEGRAM_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]);
async function telegramRequest(fn, maxRetries = 5) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = String(err?.code || "");
      const msg = String(err?.message || "");
      const retryable = RETRYABLE_TELEGRAM_CODES.has(code) || /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|TLS connection/i.test(msg);
      if (!retryable || i === maxRetries - 1) throw err;
      const wait = 500 * Math.pow(2, i);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr || new Error("telegramRequest failed");
}

const _tgSendMessage = bot.sendMessage.bind(bot);
bot.sendMessage = (...args) => telegramRequest(() => _tgSendMessage(...args));
const _tgSendChatAction = bot.sendChatAction.bind(bot);
bot.sendChatAction = (...args) => telegramRequest(() => _tgSendChatAction(...args));
const _tgGetFileLink = bot.getFileLink.bind(bot);
bot.getFileLink = (...args) => telegramRequest(() => _tgGetFileLink(...args));
const _tgGetMe = bot.getMe.bind(bot);
bot.getMe = (...args) => telegramRequest(() => _tgGetMe(...args));

let botUsername = null;

// ── Self-topic detection (group only) ───────────────────────────────────────
// 晴 主動加入對話：當群組在聊晴本身時才說話（不含天氣用語：晴天/天晴/晴朗/晴空）
const SELF_TOPIC_RE = /(?<![天])晴(?![天朗空雨])|(?:問|找|叫|說到|提到|問問)晴(?!天)/;
const _selfTopicCooldown = new Map(); // chatId → last self-topic reply timestamp
const SELF_TOPIC_COOLDOWN_MS = 3 * 60 * 1000; // 同一群組 3 分鐘內最多一次自動加入

bot.getMe()
  .then((info) => {
    botUsername = info.username;
    console.log("Telegram connected:", info.username);
    writeLog("connected", { username: info.username });
    // logConnectorReady 只在首次上線時記錄；之後的啟動改用 logRestart
    logConnectorReady("telegram", `帳號：@${info.username}`);
    logRestart("telegram", `帳號：@${info.username}`);
    startProactiveScheduler(bot, ollamaClient);
    startConnectorHeartbeat("telegram", () => ({ username: info.username }));
  })
  .catch((err) => {
    writeLog("error", { message: err.message });
    console.error("TG getMe failed:", err.message);
  });

// ??? Message batching buffer ??????????????????????????????????????????????????
// Groups rapid multi-sentence messages into a single AI turn.
// Key: chatId ?${ parts: string[], lastMsg, isDeveloper, isReplyToBot, timer }
const msgBuffer = new Map();
const BATCH_DELAY_MS = 3500; // wait 3.5s after last message before replying

function bufferMessage(chatId, inputText, msg, isDeveloper, isReplyToBot) {
  const existing = msgBuffer.get(chatId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.parts.push(inputText);
    existing.lastMsg = msg;
    // update isReplyToBot if the latest message is a reply
    if (isReplyToBot) existing.isReplyToBot = true;
  } else {
    msgBuffer.set(chatId, { parts: [inputText], lastMsg: msg, isDeveloper, isReplyToBot });
  }
  const entry = msgBuffer.get(chatId);
  entry.timer = setTimeout(() => {
    msgBuffer.delete(chatId);
    const combined = entry.parts.join("\n");
    dispatchToAI(combined, entry.lastMsg, entry.isDeveloper, entry.isReplyToBot).catch((err) => {
      console.error("[bot] buffer flush error:", err.message);
    });
  }, BATCH_DELAY_MS);
}

// ??? Core AI dispatch ?????????????????????????????????????????????????????????
// Processes a (possibly combined) message through the full pipeline and replies.
// Strip Telegram-quote prefixes injected by this bot before writing to memory.
// The AI still receives the full text (with prefix) for context;
// memory only stores the user's actual words.
const QUOTE_PREFIX_RE = /^\[(?:引用訊息[^\]]*|你之前說的：[^\]]*|使用者分享了[^\]]*)\]\n?/;

// ── Message-ID dedup ────────────────────────────────────────────────────────
// Prevents processing the same Telegram message_id twice.
// Happens after bot restarts: Telegram re-delivers pending updates.
// Keep last 200 message IDs per chatId — enough to cover any burst.
const _seenMessageIds = new Map(); // chatId → Set<message_id>
function markSeen(chatId, messageId) {
  if (!_seenMessageIds.has(chatId)) _seenMessageIds.set(chatId, new Set());
  const s = _seenMessageIds.get(chatId);
  s.add(messageId);
  if (s.size > 200) s.delete(s.values().next().value);
}
function alreadySeen(chatId, messageId) {
  return _seenMessageIds.get(chatId)?.has(messageId) ?? false;
}

// ── Dispatch lock (DM + group) ──────────────────────────────────────────────
// DM: queue while processing, flush after.
// Group: drop while processing (groups move fast; stale replies are worse than silence).
const _dispatchingChats = new Set();
const _pendingQueue     = new Map(); // chatId → [{ combinedInput, msg, isDeveloper, isReplyToBot }]

async function dispatchToAI(combinedInput, msg, isDeveloper, isReplyToBot, isSelfTopicJoin = false) {
  const chatId   = msg.chat?.id;
  const chatType = msg.chat?.type || "unknown";
  const channel  = chatType === "private" ? "private" : "group";

  // Dedup: skip if we've already processed this exact message_id
  const messageId = msg.message_id;
  if (messageId && alreadySeen(chatId, messageId)) {
    writeLog("dedup_skip", { chatId, messageId });
    return;
  }
  if (messageId) markSeen(chatId, messageId);

  // Group lock: drop if already processing this chat (groups move fast, stale replies are worse)
  if (channel === "group" && _dispatchingChats.has(chatId)) {
    writeLog("group_dispatch_drop", { chatId });
    return;
  }

  // DM lock: queue if already processing this chat
  if (channel === "private" && _dispatchingChats.has(chatId)) {
    const q = _pendingQueue.get(chatId) || [];
    q.push({ combinedInput, msg, isDeveloper, isReplyToBot });
    _pendingQueue.set(chatId, q);
    writeLog("dm_queued", { chatId, queueLen: q.length });
    return;
  }
  _dispatchingChats.add(chatId);

  // Clean version: strip quote prefix so memory stores only real user words
  const cleanInput = String(combinedInput || "").replace(QUOTE_PREFIX_RE, "").trim() || String(combinedInput || "");

  const effectiveText = msg.text || msg.caption || combinedInput;
  const mentionState = detectMention(
    { text: combinedInput, isReplyToBot },
    botUsername,
  );
  const mentionDetected = mentionState.mentionDetected;
  const isDirectMention = mentionState.isDirectMention;
  const isCommand = Boolean(
    Array.isArray(msg.entities) && msg.entities.some((e) => e.type === "bot_command")
  ) || String(effectiveText || "").startsWith("/");

  // Forum topic thread id ??present when message is inside a Telegram Forum topic
  const threadId = msg.message_thread_id || null;
  const typingOptions = threadId ? { message_thread_id: threadId } : {};

  // Send typing indicator immediately and keep refreshing until reply is ready
  bot.sendChatAction(chatId, "typing", typingOptions).catch(() => {});
  const typingInterval = setInterval(() => {
    bot.sendChatAction(chatId, "typing", typingOptions).catch(() => {});
  }, 4000);

  try {
    ingestEvent({
      platform: "telegram",
      channelType: channel,
      chatId,
      userId: msg.from?.id || null,
      senderId: msg.from?.id || null,
      senderName: msg.from?.username || msg.from?.first_name || null,
      username: msg.from?.username || null,
      firstName: msg.from?.first_name || null,
      lastName: msg.from?.last_name || null,
      text: cleanInput,
      timestamp: Date.now(),
      direction: "incoming",
      role: isDeveloper ? "developer" : "public_user",
      eventType: "message",
      meaningful: true,
      mentionDetected,
    });

    writeLog("pipeline_dispatch", {
      text: combinedInput,
      chatId,
      chatType,
      channel,
      isDirectMention,
      isDeveloper,
      userId: msg.from?.id || null,
      username: msg.from?.username || null,
    });

    const event = {
      type: "message",
      content: combinedInput,
      text: combinedInput,
      userId: msg.from?.id || null,
      senderId: msg.from?.id || null,
      senderName: msg.from?.username || msg.from?.first_name || null,
      fromId: msg.from?.id || null,
      username: msg.from?.username || null,
      firstName: msg.from?.first_name || null,
      lastName: msg.from?.last_name || null,
      languageCode: msg.from?.language_code || null,
      connector: "telegram",
      isPrivate: chatType === "private",
      channel,
      mentionDetected,
      isDirectMention,
      isCommand,
      // skipConversationBufferWrite: bot.js already writes to shortTerm via
      // ingestEvent (incoming + outgoing), so pipeline must not write again.
      meta: { isDeveloper, skipConversationBufferWrite: true, groupId: channel === "group" ? `tg_${chatId}` : null, selfTopicJoin: isSelfTopicJoin || undefined },
      chat: { id: chatId, type: chatType },
      chatId,
      replyToMessage: msg.reply_to_message
        ? {
            messageId: msg.reply_to_message.message_id || null,
            fromId: msg.reply_to_message.from?.id || null,
            username: msg.reply_to_message.from?.username || null,
            firstName: msg.reply_to_message.from?.first_name || null,
          }
        : null,
    };

    // Hard timeout ??if LLM hangs, stop typing and abort silently rather than
    // leaving "typing..." visible indefinitely in the chat.
    const AI_HARD_TIMEOUT_MS = 150000; // 150s — trading queries with heavy context can take 90-130s
    let aiTimeoutHandle;
    const aiTimeoutPromise = new Promise((_, reject) => {
      aiTimeoutHandle = setTimeout(() => reject(new Error("ai_hard_timeout")), AI_HARD_TIMEOUT_MS);
    });

    // Handle web search: inject snippets into event text before sending to orchestrator
    const searchIntent = detectSearchIntent(combinedInput);
    if (searchIntent.needsSearch && channel === "private") {
      const searchingMsg = getSearchingPhrase();
      await bot.sendMessage(chatId, searchingMsg, { reply_to_message_id: msg.message_id });
      const delay = 10000 + Math.random() * 20000;
      const [snippets] = await Promise.all([
        search(searchIntent.query),
        new Promise((r) => setTimeout(r, delay)),
      ]);
      if (snippets && snippets.trim()) {
        const augmented = `[網路搜尋結果]\n${snippets.trim()}\n\n[原始訊息] ${combinedInput}`;
        event.text    = augmented;
        event.content = augmented;
      }
    }

    // Add role to event (isDeveloper check)
    event.role = isDeveloper ? "developer" : "user";

    // Detect first meeting with this user
    const userRef = { platform: "telegram", userId: String(msg.from?.id || ""), username: msg.from?.username };
    if (!isDeveloper && !isKnownUser(userRef)) {
      event.meta.firstMeeting = true;
      event.meta.firstMeetingName = msg.from?.first_name || msg.from?.username || null;
    }

    // Detect first time in this group
    if (channel === "group" && checkAndMarkNewGroup(chatId)) {
      event.meta.newGroup = true;
      event.meta.newGroupTitle = msg.chat?.title || null;
    }

    // P2 ──inject recent group messages for context (exclude current sender + bots)
    if (channel === "group") {
      const { groupRegistry } = require("./active_chat_registry");
      const recentMsgs = groupRegistry?.get?.(chatId)?.recentMessages || [];
      // Bot / anonymous-admin usernames: exclude to prevent format contamination in LLM output
      const BOT_NAMES = new Set(["GroupAnonymousBot", "Channel_Bot", "Telegraph"]);
      const botUsername = process.env.TG_BOT_USERNAME || "scalai_bot";
      BOT_NAMES.add(botUsername);
      const others = recentMsgs
        .filter(m => String(m.userId) !== String(msg.from?.id))
        .filter(m => !BOT_NAMES.has(m.username))
        .slice(-5);
      if (others.length > 0) {
        // Plain text only — no "Username：" prefix to avoid model learning that output format
        event.meta.groupRecentMessages = others.map(m => m.text).join("\n");
      }
    }

    // P3 ??long absence detection (private chat only)
    if (channel === "private" && !isDeveloper) {
      const { makeSessionKey, getSession } = require("../../ai/memory/working_memory");
      const sessionKey = makeSessionKey(event);
      const turns = getSession(sessionKey);
      if (turns.length > 0) {
        const lastTs = turns[turns.length - 1]?.ts || 0;
        const daysSince = (Date.now() - lastTs) / (1000 * 60 * 60 * 24);
        if (daysSince >= 3) {
          event.meta.absenceDays = Math.floor(daysSince);
        }
      }
    }

    let result;
    try {
      result = await Promise.race([
        processEvent(event),
        aiTimeoutPromise,
      ]);
    } catch (innerErr) {
      clearTimeout(aiTimeoutHandle);
      if (innerErr.message === "ai_hard_timeout") {
        clearInterval(typingInterval);
        writeLog("ai_timeout", { chatId, chatType, channel, userId: msg.from?.id || null });
        return; // silent abort ??no error message sent
      }
      throw innerErr; // re-throw non-timeout errors to the outer catch
    }
    clearTimeout(aiTimeoutHandle);

    writeLog("reply", {
      text: result.reply,
      skipped: Boolean(result.skipped),
      halted: Boolean(result.halted),
      reflexTriggered: result.telemetry?.reflexTriggered || false,
      reflexPassed: result.telemetry?.reflexPassed || false,
      retryCount: result.telemetry?.retryCount || 0,
      artifactDetected: result.telemetry?.artifactDetected || false,
      reflexPath: result.telemetry?.reflexPath || "pass",
      secondLineDriftDetected: result.telemetry?.secondLineDriftDetected || false,
      intent: result.telemetry?.intent || "none",
      topicAnchor: result.telemetry?.topicAnchor || null,
      topicTurnsRemaining: result.telemetry?.topicTurnsRemaining || 0,
      initiativeLevel: result.telemetry?.initiativeLevel || 0,
      questionRatio: result.telemetry?.questionRatio || 0,
      momentumAdjusted: result.telemetry?.momentumAdjusted || false,
      judgeTriggered: result.telemetry?.judgeTriggered || false,
      rawMoodDelta: Number(result.telemetry?.rawMoodDelta || 0),
      moodBeforeEvent: Number(result.telemetry?.moodBeforeEvent || 0),
      moodAfterEvent: Number(result.telemetry?.moodAfterEvent || 0),
      moodAfterTick: Number(result.telemetry?.moodAfterTick || 0),
      emotionLevel: Number(result.telemetry?.emotionLevel || 0),
      stance: result.telemetry?.stanceAfter || "neutral",
      stanceBias: Number(result.telemetry?.stanceBias || 0),
      role: result.telemetry?.role || "public_user",
      channel,
      connector: result.telemetry?.connector || "telegram",
      personaModeKey: result.telemetry?.personaModeKey || "public_user_public",
      authoritySpoofAttempt: result.telemetry?.authoritySpoofAttempt || false,
      chatId,
      chatType,
      stanceBefore: result.telemetry?.stanceBefore || "neutral",
      stanceAfter: result.telemetry?.stanceAfter || "neutral",
      selfAwarenessState: result.telemetry?.selfAwarenessState || "normal",
      errorSeverity: result.telemetry?.errorSeverity || 0,
    });

    if (result.skipped || !result.reply) {
      clearInterval(typingInterval);
      writeLog("send_skipped", {
        chatId, chatType, channel,
        userId: msg.from?.id || null,
        reason: result.meta?.error ? `pipeline_error:${result.meta.stage}` : (result.telemetry?.engageDecision?.reason || "skipped"),
      });
      // Pipeline 錯誤時通知 developer，方便即時排查
      if (result.meta?.error && isDeveloper) {
        await bot.sendMessage(chatId,
          `[pipeline error] stage: ${result.meta.stage}\n${result.meta.error}`,
          { reply_to_message_id: msg.message_id },
        ).catch(() => {});
      }
      return;
    }

    clearInterval(typingInterval);
    console.log("Replying to:", chatId, "type:", chatType);

    // ?? Multi-part send: split long replies into 2-3 separate messages ?????????
    // Mimics natural texting. Only splits when: reply has 2+ sentences AND
    // total length > 40 chars. Deep/long content (> 200 chars) stays together.
    const replyText = result.reply;
    const msgOpts = {
      ...(channel === "group" ? { reply_to_message_id: msg.message_id } : {}),
      ...(threadId ? { message_thread_id: threadId } : {}),
    };

    const segments = splitReplyIntoSegments(replyText);
    let sent;
    if (segments.length > 1) {
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        // Show typing indicator between segments
        if (i > 0) {
          bot.sendChatAction(chatId, "typing").catch(() => {});
          // Dynamic delay: 30ms per char, capped between 500ms and 2500ms
          const delay = Math.max(500, Math.min(seg.length * 30, 2500));
          await new Promise((r) => setTimeout(r, delay));
        }
        sent = await bot.sendMessage(chatId, seg, i === 0 ? msgOpts : { ...(threadId ? { message_thread_id: threadId } : {}) });
      }
    } else {
      sent = await bot.sendMessage(chatId, replyText, msgOpts);
    }

    if (channel === "group") {
      markGroupReplySent(event);
      // Record this reply for topic continuation detection
      const { recordBotReply } = require("../../ai/gate_layer");
      recordBotReply(String(chatId), replyText);
    }

    // ── Chart screenshot: send after text reply if requested ─────────────────
    if (result.chart) {
      try {
        bot.sendChatAction(chatId, "upload_photo").catch(() => {});
        const { openChart } = require("../../ai/modules/trading/chart_viewer");
        const { screenshotB64 } = await openChart(result.chart.asset, result.chart.interval);
        const TF_LABEL = { "240": "4H", "60": "1H", "15": "15M", "5": "5M" };
        const caption  = `${result.chart.asset}/USDT ${TF_LABEL[result.chart.interval] || result.chart.interval}`;
        await bot.sendPhoto(chatId, Buffer.from(screenshotB64, "base64"), {
          caption,
          ...(threadId ? { message_thread_id: threadId } : {}),
        });
      } catch (err) {
        console.warn("[bot] chart screenshot failed:", err.message);
      }
    }

    // Track sent message for reaction feedback
    if (sent?.message_id) {
      const globalKey = getOrCreateGlobalUserKey({ platform: "telegram", userId: String(msg.from?.id || ""), username: msg.from?.username });
      trackReply(chatId, sent.message_id, {
        userId:    String(msg.from?.id || ""),
        globalKey,
        replyText: replyText,
        userText:  cleanInput,
      });
    }

    ingestEvent({
      platform: "telegram",
      channelType: channel,
      chatId,
      userId: msg.from?.id || null,
      username: msg.from?.username || null,
      firstName: msg.from?.first_name || null,
      lastName: msg.from?.last_name || null,
      text: result.reply,
      timestamp: Date.now(),
      direction: "outgoing",
      role: isDeveloper ? "developer" : "public_user",
      eventType: "reply",
      meaningful: true,
    });
    writeLog("send_success", {
      chatId, chatType, channel,
      userId: msg.from?.id || null,
      messageId: sent?.message_id || null,
    });
  } catch (err) {
    clearInterval(typingInterval);
    writeLog("send_error", { message: err.message, chatId, chatType, channel, userId: msg.from?.id || null });
    await bot.sendMessage(chatId, "抱歉，剛才出了點問題，你可以再試一次。", { reply_to_message_id: msg.message_id });
  } finally {
    // Release lock
    _dispatchingChats.delete(chatId);
    // DM only: flush queued messages as a combined turn
    if (channel === "private") {
      const queued = _pendingQueue.get(chatId);
      if (queued && queued.length > 0) {
        _pendingQueue.delete(chatId);
        const combined  = queued.map(q => q.combinedInput).join("\n");
        const lastEntry = queued[queued.length - 1];
        const anyDev    = queued.some(q => q.isDeveloper);
        const anyReply  = queued.some(q => q.isReplyToBot);
        writeLog("dm_queue_flush", { chatId, count: queued.length });
        dispatchToAI(combined, lastEntry.msg, anyDev, anyReply).catch(() => {});
      }
    }
  }
}

// ??? Message handler ??????????????????????????????????????????????????????????
bot.on("message", async (msg) => {
  _lastActivity = Date.now();
  try {
  const chatId   = msg.chat?.id;
  const chatType = msg.chat?.type || "unknown";
  const channel  = chatType === "private" ? "private" : "group";

  // ?? Resolve inputText from whatever media type was sent ??
  const hasPhoto   = Boolean(msg.photo && msg.photo.length > 0);
  const hasVideo   = Boolean(msg.video || msg.video_note);
  const hasVoice   = Boolean(msg.voice || msg.audio);
  const hasSticker = Boolean(msg.sticker);
  const hasGif     = Boolean(msg.animation);
  const effectiveText = msg.text || msg.caption || null;

  let inputText;
  if (hasSticker && !effectiveText) {
    const emoji = msg.sticker.emoji || "🎭";
    inputText = `[Sticker:${emoji}] 使用者傳了貼圖`;
  } else if (hasGif && !effectiveText) {
    inputText = "[GIF] 使用者傳了 GIF 動圖";
  } else if (!effectiveText && (hasVideo || hasVoice)) {
    if (channel === "private") {
      await bot.sendMessage(chatId, "我看到了影音訊息，但目前只能回覆文字與圖片。", { reply_to_message_id: msg.message_id });
    }
    return;
  } else if (!effectiveText && !hasPhoto) {
    return;
  } else if (hasPhoto) {
    // ?? Vision: download image and describe via vision model ??????????????????
    const caption = String(msg.caption || "").trim();
    let imageDescription = null;
    try {
      const photoFile = msg.photo[msg.photo.length - 1]; // largest size
      const fileLink = await bot.getFileLink(photoFile.file_id);
      const imgResp = await axios.get(fileLink, { responseType: "arraybuffer", timeout: 10000 });
      const base64 = Buffer.from(imgResp.data).toString("base64");
      imageDescription = await describeImage(base64, caption);
    } catch {
      // Download failed ??fall through to fallback below
    }

    if (imageDescription) {
      inputText = caption
        ? `[圖片描述：${imageDescription}]\n${caption}`
        : `[圖片描述：${imageDescription}]`;
    } else {
      // Vision model unavailable — tell AI to be honest about not seeing it
      inputText = caption
        ? `[使用者傳了一張圖片，但你無法描述其內容，請誠實說明。附帶說明：${caption}]`
        : `[使用者傳了一張圖片，但你無法描述其內容，請誠實說明。]`;
    }
  } else {
    inputText = effectiveText;
  }

  const isReplyToBot = Boolean(
    msg.reply_to_message?.from && botUsername
    && msg.reply_to_message.from.username === botUsername
  );

  // ?? Quoted message context (reply to self, others, or bot) ???????????????
  // When user replies to any message (their own, someone else's, or the bot),
  // inject the quoted content so the AI knows what's being referenced.
  const quotedMsg = msg.reply_to_message;
  if (quotedMsg) {
    // 過濾舊版程式碼遺留的垃圾字串（未插值的 template literal 殘留）
    const _rawQuoted = String(quotedMsg.text || quotedMsg.caption || "").trim();
    const quotedText = _rawQuoted.replace(/\{quotedText\.slice\([^)]*\)\}/g, "").trim();
    if (quotedText) {
      if (isReplyToBot) {
        // User is replying to the bot's own previous message ??label it clearly
        inputText = `[你之前說的：${quotedText.slice(0, 100)}」\n${inputText}`;
      } else {
        // Detect if quoted message is a channel/forwarded post (no real user sender)
        const isChannelPost = Boolean(
          quotedMsg.sender_chat ||                        // native channel post
          quotedMsg.forward_from_chat ||                  // forwarded from channel
          (!quotedMsg.from && (quotedMsg.forward_date))   // anonymous forward
        );
        if (isChannelPost) {
          const src = quotedMsg.forward_from_chat?.title || quotedMsg.sender_chat?.title || "外部頻道";
          inputText = `[使用者分享了一則來自「${src}」的外部貼文給你：${quotedText.slice(0, 150)}。這是外部的內容，不是你說的，也不是在問你。]\n${inputText}`;
        } else {
          const quotedFrom = quotedMsg.from?.username || quotedMsg.from?.first_name || "對方";
          inputText = `[引用訊息 ——${quotedFrom} 說的：${quotedText.slice(0, 100)}」\n${inputText}`;
        }
      }
    }
  }
  const isDeveloper = developerConfig.telegram.ids.includes(Number(msg.from?.id));
  const isCommand   = Boolean(
    Array.isArray(msg.entities) && msg.entities.some((e) => e.type === "bot_command")
  ) || String(effectiveText || "").startsWith("/");

  // ?? Forward detection ??
  // msg.forward_date is present on all forwarded messages (from user, channel, or anonymous)
  const isForwarded = Boolean(msg.forward_date || msg.forward_from || msg.forward_from_chat || msg.forward_sender_name);
  const mentionStateEarly = detectMention(
    { text: inputText, isReplyToBot },
    botUsername,
  );
  const mentionDetectedEarly = mentionStateEarly.mentionDetected;

  if (isForwarded) {
    if (channel === "group" && !mentionDetectedEarly) {
      // Forwarded group message not directed at bot ??register for context only, do not respond
      registerGroupMessage(chatId, {
        text: effectiveText || inputText,
        userId: msg.from?.id || null,
        username: msg.from?.username || null,
      });
      writeLog("forward_ignored", { chatId, chatType });
      return;
    }
    if (channel === "private") {
      // Strong framing: tell AI this is shared content, not a question directed at it.
      // The AI must NOT answer embedded questions as if it has knowledge of the real-world context.
      const senderName = msg.forward_from?.first_name || msg.forward_sender_name || msg.forward_from_chat?.title || "對方";
      inputText = `[使用者分享了一則來自「${senderName}」的訊息給你：${inputText}。這是轉發內容，不要直接回答它，對內容中提到的任何現實狀況（維修、預約、案件、進度等）一律不可確認。自然地對使用者分享這則訊息這件事本身做出反應。]`;
    }
  }

  // ?? Register immediately for proactive scheduler ??
  if (channel === "group") {
    registerGroupMessage(chatId, {
      text: effectiveText || inputText,
      userId: msg.from?.id || null,
      username: msg.from?.username || null,
    });
    // Social learning: sample group communication pattern every N messages
    const { groupRegistry } = require("./active_chat_registry");
    const _recentMsgs = groupRegistry?.get?.(chatId)?.recentMessages || [];
    maybeSamplePattern(`tg_${chatId}`, _recentMsgs);
    maybeSampleExpressions(`tg_${chatId}`, _recentMsgs);
    maybeSampleTopics(`tg_${chatId}`, _recentMsgs);
  } else {
    const globalKey = getOrCreateGlobalUserKey({
      platform: "telegram",
      userId: msg.from?.id || null,
      username: msg.from?.username || null,
      role: isDeveloper ? "developer" : "public_user",
    });
    registerDmUser(msg.from?.id, {
      chatId,
      username: msg.from?.username || null,
      firstName: msg.from?.first_name || null,
      globalKey,
    });
  }

  writeLog("incoming", {
    text: inputText,
    chatId, chatType, channel,
    isDeveloper,
    userId: msg.from?.id || null,
    username: msg.from?.username || null,
  });

  // ── Group gate (gate_layer) ──────────────────────────────────────────────────
  if (channel === "group" && !isCommand) {
    // Assign / retrieve user code
    const userRef  = `telegram:${msg.from?.id}`;
    getOrCreateCode(userRef);

    // Pull familiarity from memory
    let familiarity = 0;
    let lastInteractionAt = 0;
    try {
      const identity = getIdentityTruth(userRef);
      familiarity       = identity.relationship.familiarity || 0;
      lastInteractionAt = identity.relationship.lastInteractionAt || 0;
    } catch {}

    const isReplyToBot = !!(msg.reply_to_message?.from?.is_bot);
    const gate = shouldDispatch({
      text:             inputText,
      isPrivate:        false,
      isMention:        mentionDetectedEarly,
      isCommand,
      groupId:          String(chatId),
      role:             isDeveloper ? "developer" : "public_user",
      familiarity,
      lastInteractionAt,
      replyToBot:       isReplyToBot,
    });

    if (!gate.pass) {
      writeLog("group_gate_skip", { chatId, reason: gate.reason, userId: msg.from?.id || null });
      return;
    }

    const isSelfTopic = gate.reason === "name_mentioned";
    writeLog("group_gate_pass", { chatId, reason: gate.reason, userId: msg.from?.id || null, text: inputText.slice(0, 60) });
    dispatchToAI(inputText, msg, isDeveloper, false, isSelfTopic).catch((err) => {
      console.error("[bot] gate_layer dispatch error:", err.message);
    });
    return;
  }

  // ?? Commands bypass buffer ??process immediately ??
  if (isCommand) {
    // P1 ??/notify command (developer only): tell ??about a new feature/change
    if (isDeveloper && /^\/notify(\s|$)/.test(inputText)) {
      const note = inputText.replace(/^\/notify\s*/, "").trim();
      if (note) {
        // 偵測是否為程式修改／bugfix／升級 → 用情感更強的 logCodeMod
        const isCodeMod = /修|fix|bug|改|更新|升級|patch|update|refactor|重構|調整|刪掉|移除|重寫/i.test(note);
        if (isCodeMod) {
          logCodeMod(note);
        } else {
          const { appendEvent: ae } = require("../../ai/system_event_log");
          ae("new_feature", note);
        }
        await bot.sendMessage(chatId, "好，記下來了，她下次說話就會知道了。").catch(() => {});
      } else {
        await bot.sendMessage(chatId, "用法：/notify <說明>").catch(() => {});
      }
      return;
    }
    await dispatchToAI(inputText, msg, isDeveloper, isReplyToBot);
    return;
  }

  // ?? Buffer regular messages; flush after 3.5s of silence ??
  bufferMessage(chatId, inputText, msg, isDeveloper, isReplyToBot);
  } catch (err) {
    writeLog("message_handler_error", { message: err.message, stack: err.stack?.slice(0, 300), chatId: msg.chat?.id });
  }
});

// ??? Reaction feedback handler ????????????????????????????????????????????????
// Fires when a user adds or changes a reaction on any message.
// We only care about reactions on BOT messages (outgoing replies).
bot.on("message_reaction", (update) => {
  try {
    const chatId    = update.chat?.id;
    const messageId = update.message_id;
    if (!chatId || !messageId) return;

    // Only process new reactions (not removals)
    const newReactions = update.new_reaction || [];
    if (newReactions.length === 0) return;

    const entry = lookupReply(chatId, messageId);
    if (!entry) return; // not a bot message we tracked

    const emoji = newReactions[0]?.emoji || "";
    processReaction({
      platform:  "telegram",
      userId:    entry.userId,
      globalKey: entry.globalKey,
      replyText: entry.replyText,
      userText:  entry.userText,
      emoji,
    });
  } catch (e) {
    // non-blocking
  }
});

bot.on("polling_error", (err) => {
  writeLog("error", { message: err.message });
});





