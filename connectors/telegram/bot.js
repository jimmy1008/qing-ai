const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { processEvent }             = require("../../ai/orchestrator");
const { createMultiModelClient }   = require("../../ai/llm_client");
const { detectSearchIntent, search, getSearchingPhrase } = require("../../ai/web_search");
const { ingestEvent } = require("../../ai/memory_bus");
const { describeImage } = require("../../ai/image_describer");
const { markGroupReplySent, getGroupState } = require("../../ai/group_presence_engine");
const { detectMention } = require("../../ai/mention_detector");
const developerConfig = require("../../config/developer_config");
const { registerGroupMessage, registerDmUser, checkAndMarkNewGroup } = require("./active_chat_registry");
const { getOrCreateGlobalUserKey, isKnownUser } = require("../../ai/global_identity_map");
const { startProactiveScheduler } = require("../../ai/telegram_proactive_scheduler");
const { trackReply, lookupReply }  = require("./reaction_tracker");
const { processReaction }          = require("../../ai/feedback_receptor");
const { logConnectorReady }        = require("../../ai/system_event_log");
const { maybeSamplePattern }       = require("../../ai/social_pattern_memory");
const { startConnectorHeartbeat }  = require("../../ai/connector_heartbeat_client");

const token = process.env.TG_TOKEN;
const ollamaClient = createMultiModelClient(); // still used by proactive scheduler

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

  const parts = t.split(/(?<=[?‚ï?ï¼??~ï½ž])\s*/).map((s) => s.trim()).filter(Boolean);
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
  fs.appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), stage, ...data })}\n`);
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
let botUsername = null;

bot.getMe()
  .then((info) => {
    botUsername = info.username;
    console.log("Telegram connected:", info.username);
    writeLog("connected", { username: info.username });
    logConnectorReady("telegram", `å¸³è?ï¼š@${info.username}`);
    startProactiveScheduler(bot, ollamaClient);
    startConnectorHeartbeat("telegram", () => ({ username: info.username }));
  })
  .catch((err) => {
    writeLog("error", { message: err.message });
    console.error("TG getMe failed:", err.message);
  });

// ?€?€?€ Message batching buffer ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// Groups rapid multi-sentence messages into a single AI turn.
// Key: chatId ??{ parts: string[], lastMsg, isDeveloper, isReplyToBot, timer }
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

// ?€?€?€ Core AI dispatch ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// Processes a (possibly combined) message through the full pipeline and replies.
// Strip Telegram-quote prefixes injected by this bot before writing to memory.
// The AI still receives the full text (with prefix) for context;
// memory only stores the user's actual words.
const QUOTE_PREFIX_RE = /^\[(?:å¼•ç”¨è¨Šæ¯[^\]]*|ä½ ä??èªªï¼šã€Œ[^?]*?|ä½¿ç”¨?…å?äº«ä?[^\]]*)\]\n?/;

// ?€?€ DM reply lock ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// Prevents overlapping AI dispatches for the same private chat.
// If a second message arrives while the first is still processing,
// it's queued and flushed as a combined turn after the current dispatch finishes.
const _dispatchingChats = new Set();
const _pendingQueue     = new Map(); // chatId ??[{ combinedInput, msg, isDeveloper, isReplyToBot }]

async function dispatchToAI(combinedInput, msg, isDeveloper, isReplyToBot) {
  const chatId   = msg.chat?.id;
  const chatType = msg.chat?.type || "unknown";
  const channel  = chatType === "private" ? "private" : "group";

  // DM lock: queue if already processing this chat
  if (channel === "private" && _dispatchingChats.has(chatId)) {
    const q = _pendingQueue.get(chatId) || [];
    q.push({ combinedInput, msg, isDeveloper, isReplyToBot });
    _pendingQueue.set(chatId, q);
    writeLog("dm_queued", { chatId, queueLen: q.length });
    return;
  }
  if (channel === "private") _dispatchingChats.add(chatId);

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
      meta: { isDeveloper, skipConversationBufferWrite: true, groupId: channel === "group" ? `tg_${chatId}` : null },
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
    const AI_HARD_TIMEOUT_MS = 90000; // 90s
    let aiTimeoutHandle;
    const aiTimeoutPromise = new Promise((_, reject) => {
      aiTimeoutHandle = setTimeout(() => reject(new Error("ai_hard_timeout")), AI_HARD_TIMEOUT_MS);
    });

    // Handle web search: inject snippets into event text before sending to orchestrator
    const searchIntent = detectSearchIntent(combinedInput);
    if (searchIntent.needsSearch && channel === "private") {
      const searchingMsg = getSearchingPhrase();
      await bot.sendMessage(chatId, "§Ú¬Ý¨ì¤F¼v­µ°T®§¡A¦ý¥Ø«e¥u¯àª½±µÅª¤å¦r»P¹Ï¤ù¡C", { reply_to_message_id: msg.message_id });
      const delay = 10000 + Math.random() * 20000;
      const [snippets] = await Promise.all([
        search(searchIntent.query),
        new Promise((r) => setTimeout(r, delay)),
      ]);
      if (snippets && snippets.trim()) {
        const augmented = `[ç¶²è·¯?œå?çµæ?]\n${snippets.trim()}\n\n[?¨æˆ¶?é?] ${combinedInput}`;
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

    // P2 ??inject recent group messages for context (exclude current sender's message)
    if (channel === "group") {
      const { groupRegistry } = require("./active_chat_registry");
      const recentMsgs = groupRegistry?.get?.(chatId)?.recentMessages || [];
      const others = recentMsgs
        .filter(m => String(m.userId) !== String(msg.from?.id))
        .slice(-5);
      if (others.length > 0) {
        event.meta.groupRecentMessages = others
          .map(m => `${m.username || "?"}ï¼?{m.text}`)
          .join("\n");
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
        reason: result.telemetry?.engageDecision?.reason || "skipped",
      });
      return;
    }

    clearInterval(typingInterval);
    console.log("Replying to:", chatId, "type:", chatType);

    // ?€?€ Multi-part send: split long replies into 2-3 separate messages ?€?€?€?€?€?€?€?€?€
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

    if (channel === "group") markGroupReplySent(event);

    // Track sent message for reaction feedback
    if (sent?.message_id) {
      const globalKey = getOrCreateGlobalUserKey({ platform: "telegram", userId: String(msg.from?.id || ""), username: msg.from?.username });
      trackReply(chatId, sent.message_id, {
        userId:    String(msg.from?.id || ""),
        globalKey,
        replyText: replyText,
        userText:  inputText,
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
    await bot.sendMessage(chatId, "§Ú¬Ý¨ì¤F¼v­µ°T®§¡A¦ý¥Ø«e¥u¯àª½±µÅª¤å¦r»P¹Ï¤ù¡C", { reply_to_message_id: msg.message_id });
  } finally {
    // Release DM lock and flush any queued messages as a combined turn
    if (channel === "private") {
      _dispatchingChats.delete(chatId);
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

// ?€?€?€ Message handler ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
bot.on("message", async (msg) => {
  try {
  const chatId   = msg.chat?.id;
  const chatType = msg.chat?.type || "unknown";
  const channel  = chatType === "private" ? "private" : "group";

  // ?€?€ Resolve inputText from whatever media type was sent ?€?€
  const hasPhoto   = Boolean(msg.photo && msg.photo.length > 0);
  const hasVideo   = Boolean(msg.video || msg.video_note);
  const hasVoice   = Boolean(msg.voice || msg.audio);
  const hasSticker = Boolean(msg.sticker);
  const hasGif     = Boolean(msg.animation);
  const effectiveText = msg.text || msg.caption || null;

  let inputText;
  if (hasSticker && !effectiveText) {
    const emoji = msg.sticker.emoji || "?˜¶";
    inputText = `[Sticker:${emoji}] ¨Ï¥ÎªÌ¶Ç¤F¶K¹Ï`;
  } else if (hasGif && !effectiveText) {
    inputText = "[GIF] ¨Ï¥ÎªÌ¶Ç¤F GIF °Ê¹Ï";
  } else if (!effectiveText && (hasVideo || hasVoice)) {
    if (channel === "private") {
      await bot.sendMessage(chatId, "§Ú¬Ý¨ì¤F¼v­µ°T®§¡A¦ý¥Ø«e¥u¯àª½±µÅª¤å¦r»P¹Ï¤ù¡C", { reply_to_message_id: msg.message_id });
    }
    return;
  } else if (!effectiveText && !hasPhoto) {
    return;
  } else if (hasPhoto) {
    // ?€?€ Vision: download image and describe via vision model ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
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
        ? `[?–ç??è¿°ï¼?{imageDescription}]\n${caption}`
        : `[?–ç??è¿°ï¼?{imageDescription}]`;
    } else {
      // Vision model unavailable ??tell AI to be honest about not seeing it
      inputText = caption
        ? `[ä½¿ç”¨?…å‚³äº†ä?å¼µå??‡ï?ä½ ç„¡æ³•å??å??‡å…§å®¹ï??ªæ?èªªæ??‡å?ï¼šã€?{caption}?ï??¹æ?èªªæ??‡å??žæ??³å¯ï¼Œä??¯æ?ç©ºæ?è¿°å??‡]`
        : `[ä½¿ç”¨?…å‚³äº†ä?å¼µå??‡ï?ä½†ä??¡æ??‹è??–æ?è¿°å…¶?§å®¹ï¼Œè?èª å¯¦?ŠçŸ¥]`;
    }
  } else {
    inputText = effectiveText;
  }

  const isReplyToBot = Boolean(
    msg.reply_to_message?.from && botUsername
    && msg.reply_to_message.from.username === botUsername
  );

  // ?€?€ Quoted message context (reply to self, others, or bot) ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
  // When user replies to any message (their own, someone else's, or the bot),
  // inject the quoted content so the AI knows what's being referenced.
  const quotedMsg = msg.reply_to_message;
  if (quotedMsg) {
    const quotedText = String(quotedMsg.text || quotedMsg.caption || "").trim();
    if (quotedText) {
      if (isReplyToBot) {
        // User is replying to the bot's own previous message ??label it clearly
        inputText = `[ä½ ä??èªªï¼šã€?{quotedText.slice(0, 100)}?]\n${inputText}`;
      } else {
        // Detect if quoted message is a channel/forwarded post (no real user sender)
        const isChannelPost = Boolean(
          quotedMsg.sender_chat ||                        // native channel post
          quotedMsg.forward_from_chat ||                  // forwarded from channel
          (!quotedMsg.from && (quotedMsg.forward_date))   // anonymous forward
        );
        if (isChannelPost) {
          const src = quotedMsg.forward_from_chat?.title || quotedMsg.sender_chat?.title || "å¤–éƒ¨?»é?";
          inputText = `[ä½¿ç”¨?…å?äº«ä?ä¸€?‡ä??ªã€?{src}?ç?å¤–éƒ¨è²¼æ?çµ¦ä??‹ï???{quotedText.slice(0, 150)}?ã€‚é€™æ˜¯?¥äºº?¼ä??„å…§å®¹ï?ä¸æ˜¯ä½ èªª?„ï?ä¹Ÿä??¯å??¹èªª?„]\n${inputText}`;
        } else {
          const quotedFrom = quotedMsg.from?.username || quotedMsg.from?.first_name || "å°æ–¹";
          inputText = `[å¼•ç”¨è¨Šæ¯ ??${quotedFrom} èªªï???{quotedText.slice(0, 100)}?]\n${inputText}`;
        }
      }
    }
  }
  const isDeveloper = developerConfig.telegram.ids.includes(Number(msg.from?.id));
  const isCommand   = Boolean(
    Array.isArray(msg.entities) && msg.entities.some((e) => e.type === "bot_command")
  ) || String(effectiveText || "").startsWith("/");

  // ?€?€ Forward detection ?€?€
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
      const senderName = msg.forward_from?.first_name || msg.forward_sender_name || msg.forward_from_chat?.title || "?äºº";
      inputText = `[ä½¿ç”¨?…è??³ä?ä¸€?‡ä??ªã€?{senderName}?ç?è¨Šæ¯çµ¦ä??‹ï??§å®¹?¯ï???{inputText}?ã€‚é€™ä??¯ä½¿?¨è€…ç›´?¥å?ä½ ç??é?ï¼Œä?å°è??¯ä¸­?åˆ°?„ä»»ä½•ç¾å¯¦ç?æ³ï?ç¶­ä¿®?ç?å®šã€ä?ä»¶ã€é€²åº¦ç­‰ï?ä¸€?¡æ??¥ï?ä¸å¯?é€ å?ç­”ã€‚è‡ª?¶åœ°?žæ?ä½¿ç”¨?…å?äº«é€™å?è¨Šæ¯?™ä»¶äº‹æœ¬èº«ã€‚]`;
    }
  }

  // ?€?€ Register immediately for proactive scheduler ?€?€
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

  // ?€?€ Group gate: only dispatch if bot was directly @mentioned or replied to ?€?€
  // Non-@mention group messages are registered for context (proactive scheduler)
  // but must NOT reach the pipeline ??prevents error messages leaking into group chats.
  if (channel === "group" && !mentionDetectedEarly && !isCommand) {
    writeLog("group_nomention_skip", { chatId, chatType, userId: msg.from?.id || null });
    return;
  }

  // ?€?€ Commands bypass buffer ??process immediately ?€?€
  if (isCommand) {
    // P1 ??/notify command (developer only): tell ??about a new feature/change
    if (isDeveloper && /^\/notify(\s|$)/.test(inputText)) {
      const note = inputText.replace(/^\/notify\s*/, "").trim();
      if (note) {
        const { appendEvent: ae } = require("../../ai/system_event_log");
        ae("new_feature", note);
        await bot.sendMessage(chatId, "??è¨˜ä?ä¾†ä?ï¼Œå¥¹ä¸‹æ¬¡èªªè©±å°±æ??¥é?").catch(() => {});
      } else {
        await bot.sendMessage(chatId, "?¨æ?ï¼?notify <?§å®¹>").catch(() => {});
      }
      return;
    }
    await dispatchToAI(inputText, msg, isDeveloper, isReplyToBot);
    return;
  }

  // ?€?€ Buffer regular messages; flush after 3.5s of silence ?€?€
  bufferMessage(chatId, inputText, msg, isDeveloper, isReplyToBot);
  } catch (err) {
    writeLog("message_handler_error", { message: err.message, stack: err.stack?.slice(0, 300), chatId: msg.chat?.id });
  }
});

// ?€?€?€ Reaction feedback handler ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
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




