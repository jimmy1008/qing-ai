const { isWithinActiveHours, getDriveContext } = require("./threads_activity_scheduler");
const { isPhoneConnected, pushToPhone } = require("../connectors/phone/phone_push");
const { synthesize: ttsSynthesize } = require("./tts_engine");
const { getCurrentMood } = require("./mood_engine");
const { getInertiaState, tickInertia, getRecentStateHistory } = require("./inertia_engine");
const { shouldInitiateConversation, markInitiation } = require("./relationship_engine");
const { getOrCreateGlobalUserKey } = require("./global_identity_map");
const memoryStore = require("../memory/memory_store");
const { ingestEvent } = require("./memory_bus");
const { getActiveGroups, getKnownDmUsers } = require("../connectors/telegram/active_chat_registry");
const { PERSONA_HARD_LOCK, IMMUTABLE_PERSONA_CORE, STYLE_CONTRACT } = require("./persona_core");

// Per-group last proactive send timestamp (in-memory only)
const groupLastSent = new Map();
const GROUP_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour per group

// Interval range for proactive ticks
const MIN_INTERVAL_MS = 3 * 60 * 1000;  // 3 min
const MAX_INTERVAL_MS = 10 * 60 * 1000; // 10 min

let schedulerTimer = null;

function randomInterval() {
  return MIN_INTERVAL_MS + Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS));
}

// Decide whether to speak and generate a remark using full persona context
async function generateGroupRemark(recentMessages, mood, ollamaClient) {
  const contextLines = recentMessages
    .slice(-6)
    .map((m) => `${m.username || "某人"}：${m.text}`)
    .join("\n");

  if (!contextLines.trim()) return null;

  const moodLabel = { PLAYFUL: "活潑", CURIOUS: "好奇", CALM: "平靜", TIRED: "疲倦", WITHDRAWN: "退縮" }[mood] || "平靜";

  const moodDesc = { PLAYFUL: "你現在心情輕鬆有點皮，說話帶點能量。", CURIOUS: "你現在狀態挺投入，腦子轉得快。", CALM: "你現在比較沈穩，說話直接，不多廢話。", TIRED: "你現在有點懶，話少，回應精簡。", WITHDRAWN: "你現在比較沈默，不太想主動展開話題。" }[mood] || "";
  const systemPrompt = [PERSONA_HARD_LOCK, "", IMMUTABLE_PERSONA_CORE, "", STYLE_CONTRACT, "", "【場景】群聊。簡短，不搶戲，保持輕快。最多 1-2 句。", moodDesc ? `\n[當前狀態]\n${moodDesc}` : ""].join("\n");

  const prompt = [
    `群組最近的對話紀錄：`,
    contextLines,
    "",
    `你現在心情${moodLabel}。靜靜看完這些訊息後，判斷有沒有什麼值得說的。`,
    "如果這段對話沒有讓你有任何感覺：只輸出「沉默」。",
    "如果有想說的：直接說那句話，不要解釋，不要問問題，不要說明你為什麼說，30字以內。",
    "只輸出那句話，或「沉默」。",
  ].join("\n");

  const TIMEOUT_MS = 20000;
  try {
    const raw = await Promise.race([
      (ollamaClient.generateFast || ollamaClient.generate)({
        system: systemPrompt,
        prompt,
        options: { temperature: 0.78, num_predict: 80 },
        priority: 3,  // background — yields to active conversations
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
    ]);
    const text = String(raw || "").trim();
    if (!text || /^沉默/.test(text)) return null;
    // Strip any label prefix the model might add
    return text.replace(/^(回應|輸出|說|插話)\s*[:：]\s*/i, "").trim().slice(0, 80) || null;
  } catch (err) {
    console.error("[proactive_scheduler] generateGroupRemark failed:", err.message);
    return null;
  }
}

async function tryGroupInitiative(bot, ollamaClient) {
  if (!isWithinActiveHours()) return false;

  const inertiaState = getInertiaState();
  if (inertiaState.currentIntent === "scrolling") return false;

  const moodState = getCurrentMood("Asia/Taipei", {
    drive: inertiaState.drive || 0,
    activeChats: getDriveContext().activeChatCount || 0,
  });
  const mood = moodState.mood;

  // Withdrawn mood = don't proactively speak
  if (mood === "WITHDRAWN" || mood === "TIRED") return false;

  const activeGroups = getActiveGroups(30 * 60 * 1000);
  if (!activeGroups.length) return false;

  // Pick a random active group that's past cooldown
  const now = Date.now();
  const eligible = activeGroups.filter((g) => now - (groupLastSent.get(g.chatId) || 0) >= GROUP_COOLDOWN_MS);
  if (!eligible.length) return false;

  const group = eligible[Math.floor(Math.random() * eligible.length)];
  const remark = await generateGroupRemark(group.recentMessages || [], mood, ollamaClient);
  if (!remark) return false;

  try {
    await bot.sendMessage(group.chatId, remark);
    groupLastSent.set(group.chatId, now);
    ingestEvent({
      platform: "telegram",
      channelType: "group",
      chatId: group.chatId,
      text: remark,
      timestamp: now,
      direction: "outgoing",
      eventType: "proactive_group",
      meaningful: false,
    });
    return true;
  } catch (err) {
    console.error("[proactive_scheduler] group sendMessage failed:", err.message);
    return false;
  }
}

async function generateDmRemark(user, identityMemory, mood, ollamaClient) {
  const relationship = identityMemory.relationship || {};
  const lastTopic = relationship.lastTopic || "";
  const knownFacts = (identityMemory.longTerm?.knownFacts || [])
    .filter((f) => (f.confidence || 0) >= 0.7)
    .slice(0, 3)
    .map((f) => f.fact)
    .join("; ");

  const conversationKey = memoryStore.getConversationMemoryKey({
    channel: "private",
    chatId: user.chatId,
    platform: "telegram",
    globalUserKey: user.globalKey,
  });
  const conversationMemory = memoryStore.getMemory(conversationKey);
  const recentLines = (conversationMemory.shortTerm || [])
    .slice(-4)
    .map((m) => `${m.role === "bot" ? "我" : "對方"}：${m.text}`)
    .join("\n");

  const role = identityMemory.longTerm?.role || "public_user";
  const moodDescDm = { PLAYFUL: "你現在心情輕鬆有點皮，說話帶點能量。", CURIOUS: "你現在狀態挺投入，腦子轉得快。", CALM: "你現在比較沈穩，說話直接，不多廢話。", TIRED: "你現在有點懶，話少，回應精簡。", WITHDRAWN: "你現在比較沈默，不太想主動展開話題。" }[mood] || "";
  const systemPrompt = [PERSONA_HARD_LOCK, "", IMMUTABLE_PERSONA_CORE, "", STYLE_CONTRACT, "", "【場景】私聊。語氣直接自然，可稍親密。最多 2-3 句。", moodDescDm ? `\n[當前狀態]\n${moodDescDm}` : ""].join("\n");

  const contextParts = [];
  if (recentLines) contextParts.push(`最近對話：\n${recentLines}`);
  if (lastTopic) contextParts.push(`（你們之前聊過：${lastTopic}）`);
  if (knownFacts) contextParts.push(`（你對這個人的印象：${knownFacts}）`);

  const prompt = [
    contextParts.join("\n") || "（沒有特別的背景資料）",
    "",
    "你現在想主動傳一則私訊給對方。",
    "根據你對這個人的了解或最近發生的事，如果你自己有什麼感覺或想法，就說出來。",
    "如果沒有真實感覺或只是想「追蹤」對方說過的話：輸出「沉默」。",
    "CRITICAL: 禁止模板式追蹤句，例如「你上次說的XX怎麼樣了」「你上次提到的XX後來呢」「最近有沒有又XXX」。",
    "說的是你自己當下的感覺、反應或想法，不是在follow up。",
    "如果有想說的：直接說，不要解釋，不要問問題，40字以內。",
    "只輸出那句話，或「沉默」。",
  ].join("\n");

  const TIMEOUT_MS = 20000;
  try {
    const raw = await Promise.race([
      (ollamaClient.generateFast || ollamaClient.generate)({
        system: systemPrompt,
        prompt,
        options: { temperature: 0.75, num_predict: 80 },
        priority: 3,  // background — yields to active conversations
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
    ]);
    const text = String(raw || "").trim();
    if (!text || /^沉默/.test(text)) return null;
    return text.replace(/^(回應|輸出|說|傳訊)\s*[:：]\s*/i, "").trim().slice(0, 80) || null;
  } catch (err) {
    console.error("[proactive_scheduler] generateDmRemark failed:", err.message);
    return null;
  }
}

async function tryDmInitiative(bot, ollamaClient) {
  const knownUsers = getKnownDmUsers();
  if (!knownUsers.length) return false;

  const shuffled = [...knownUsers].sort(() => Math.random() - 0.5);
  const moodState = getCurrentMood("Asia/Taipei", { drive: getInertiaState().drive || 0 });

  for (const user of shuffled) {
    const globalKey = user.globalKey;
    if (!globalKey) continue;

    const identityMemory = memoryStore.getIdentityMemory(globalKey);
    if (!identityMemory) continue;

    const relationship = identityMemory.relationship || {};
    const role = identityMemory.longTerm?.role || "public_user";

    if (!shouldInitiateConversation(relationship, { role, channel: "private" })) continue;

    const text = await generateDmRemark(user, identityMemory, moodState.mood, ollamaClient);
    if (!text) continue;

    try {
      await bot.sendMessage(user.chatId, text);
      markInitiation(relationship);
      ingestEvent({
        platform: "telegram",
        channelType: "private",
        chatId: user.chatId,
        userId: user.telegramUserId,
        username: user.username,
        text,
        timestamp: Date.now(),
        direction: "outgoing",
        eventType: "proactive_dm",
        meaningful: true,
      });
      return true;
    } catch (err) {
      console.error("[proactive_scheduler] DM sendMessage failed:", err.message);
      continue;
    }
  }

  return false;
}

// ── Phone proactive push ──────────────────────────────────────────────────────
async function tryPhoneInitiative(ollamaClient) {
  if (!isPhoneConnected()) return false;
  try {
    const moodState = getCurrentMood("Asia/Taipei", { drive: getInertiaState().drive || 0 });
    // Reuse DM remark generation — pick first known DM user as context, or use generic
    const knownUsers = (() => { try { return require("../connectors/telegram/active_chat_registry").getKnownDmUsers(); } catch { return []; } })();
    const user = knownUsers[0] || { username: "user" };
    const identityMemory = knownUsers[0] ? memoryStore.getIdentityMemory(knownUsers[0].globalKey) : {};
    const text = await generateDmRemark(user, identityMemory || {}, moodState.mood, ollamaClient);
    if (!text) return false;
    const audio = await ttsSynthesize(text);
    const sent = pushToPhone(text, audio);
    if (sent) console.log("[proactive_scheduler] pushed to phone:", text.slice(0, 60));
    return sent;
  } catch (err) {
    console.error("[proactive_scheduler] tryPhoneInitiative failed:", err.message);
    return false;
  }
}

async function runProactiveTick(bot, ollamaClient) {
  try {
    const driveContext = getDriveContext();
    // Low drive = less likely to initiate
    const drive = getInertiaState().drive || 0;
    if (drive < 3) return;
    console.log(`[proactive_tick] drive=${drive.toFixed(2)} mood=${getCurrentMood("Asia/Taipei", {}).mood}`);

    // Phone push runs in parallel with Telegram (independent channel)
    if (isPhoneConnected()) {
      tryPhoneInitiative(ollamaClient).catch(() => {});
    }

    // 65% group, 35% DM; if one fails, try the other
    if (Math.random() < 0.65) {
      const groupOk = await tryGroupInitiative(bot, ollamaClient);
      if (!groupOk) await tryDmInitiative(bot, ollamaClient);
    } else {
      const dmOk = await tryDmInitiative(bot, ollamaClient);
      if (!dmOk) await tryGroupInitiative(bot, ollamaClient);
    }
  } catch (err) {
    console.error("[proactive_scheduler] runProactiveTick failed:", err.message);
  }
}

function scheduleNext(bot, ollamaClient) {
  const delay = randomInterval();
  schedulerTimer = setTimeout(async () => {
    await runProactiveTick(bot, ollamaClient);
    scheduleNext(bot, ollamaClient);
  }, delay);
}

function warmupDriveFromHistory() {
  // On startup, restore drive from the last recorded telemetry tick.
  // tickInertia uses exponential smoothing (prev*0.72 + target*0.28), so a single tick
  // only reaches 28% of target. We run multiple ticks to converge to the historical value.
  try {
    const history = getRecentStateHistory(5);
    if (!history.length) return;
    const last = history[history.length - 1];
    const targetDrive = Math.min(last.toDrive || 0, 6); // cap to avoid spike
    if (targetDrive <= 0) return;
    // Run 8 ticks — after 8 iterations smoothing converges to ~97% of target
    for (let i = 0; i < 8; i++) {
      tickInertia({ source: "warmup", mood: last.mood || "CALM", drive: targetDrive });
    }
    const actual = getInertiaState().drive;
    console.log(`[proactive_scheduler] drive warmup: target=${targetDrive.toFixed(2)} actual=${actual.toFixed(2)}`);
  } catch {
    // non-fatal — scheduler still starts without warmup
  }
}

function startProactiveScheduler(bot, ollamaClient) {
  if (schedulerTimer) return; // already running
  warmupDriveFromHistory();
  scheduleNext(bot, ollamaClient);
}

function stopProactiveScheduler() {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}

module.exports = { startProactiveScheduler, stopProactiveScheduler };
