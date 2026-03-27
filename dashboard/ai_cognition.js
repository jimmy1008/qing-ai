let mergedInterval = null;

const moodMap = {
  PLAYFUL: "活潑",
  CURIOUS: "好奇",
  CALM: "平靜",
  TIRED: "疲倦",
  WITHDRAWN: "退縮",
};

const intentMap = {
  scrolling: "滑文中",
  chatting: "聊天中",
  idle: "待機中",
};

async function ensureAuth() {
  const urlToken = new URLSearchParams(window.location.search).get("teamToken") || "";
  let token = urlToken || localStorage.getItem("teamToken") || "";
  if (!token) {
    token = prompt("請輸入 Team Token");
    if (!token) throw new Error("missing_token");
  }
  localStorage.setItem("teamToken", token);

  const res = await fetch("/api/me", { headers: { "x-team-token": token } });
  if (!res.ok) {
    localStorage.removeItem("teamToken");
    throw new Error("unauthorized");
  }
  const me = await res.json();
  localStorage.setItem("userRole", me.role);
  if (me.role !== "superadmin") throw new Error("forbidden");
}

// authFetch is provided by auth.js (loaded before this script)

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.innerText = value;
}

function formatRelativeMinutes(timestamp) {
  if (!timestamp) return "尚未滑文";
  const value = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(value)) return "尚未滑文";
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000));
  return `${minutes} 分鐘前`;
}

function maskName(name) {
  const raw = String(name || "");
  if (!raw || /^\d+$/.test(raw)) return null;
  return raw;
}

function renderList(containerId, items, formatter, emptyText = "無資料") {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!Array.isArray(items) || items.length === 0) {
    container.innerHTML = `<div class="card compact-card"><div class="value small">${escapeHtml(emptyText)}</div></div>`;
    return;
  }
  container.innerHTML = items
    .map((item, idx) => formatter(item, idx))
    .filter(Boolean)
    .map((line) => `<div class="card compact-card"><div class="value small">${line}</div></div>`)
    .join("");
}

function formatInteraction(item, index) {
  const nickname = maskName(item.nickname);
  if (!nickname) return "";
  const type = item.type || "message";
  const ts = item.timestamp
    ? new Date(item.timestamp).toLocaleTimeString("zh-TW", { hour12: false })
    : "--";
  return `${index + 1}. ${escapeHtml(nickname)} - ${escapeHtml(type)} (${ts})`;
}

function formatEmotionEvent(item, index) {
  const delta = Number(item.delta || 0);
  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  const reason = item.reason || item.type || "event";
  return `${index + 1}. ${escapeHtml(sign)} ${escapeHtml(reason)}`;
}

function formatFamiliar(item, index) {
  const nickname = maskName(item.nickname || item.name);
  if (!nickname) return "";
  return `${index + 1}. ${escapeHtml(nickname)} - ${Number(item.familiarity || 0)}`;
}

function stringifyCompact(obj) {
  if (!obj || typeof obj !== "object") return "--";
  try {
    return JSON.stringify(obj);
  } catch {
    return "--";
  }
}

function renderRuntimeLayer(runtimeLayer = {}) {
  setText("rtIdImpulses", Array.isArray(runtimeLayer.idImpulses) && runtimeLayer.idImpulses.length
    ? runtimeLayer.idImpulses.join(", ")
    : "--");
  setText("rtIdAffect", runtimeLayer.idAffect ? stringifyCompact(runtimeLayer.idAffect) : "--");
  setText("rtEgoArchetype", runtimeLayer.egoArchetype || "--");
  setText("rtAlignmentScore", runtimeLayer.alignmentScore != null ? String(runtimeLayer.alignmentScore) : "--");

  const sceneGate = runtimeLayer.sceneGateResult || {};
  const memoryGate = runtimeLayer.memoryGateResult || {};
  const intimacyGate = runtimeLayer.intimacyGateResult || {};
  const superego = runtimeLayer.superego || {};
  const stateModel = runtimeLayer.stateModel || {};
  const routing = {
    historyLength: runtimeLayer.historyLength ?? "--",
    speakerCount: runtimeLayer.speakerCount ?? "--",
    promptLength: runtimeLayer.promptLength ?? "--",
    chatMode: runtimeLayer.chatMode || "--",
    currentSpeaker: runtimeLayer.currentSpeaker || null,
    targetSpeaker: runtimeLayer.targetSpeaker || null,
  };

  const sceneFail = sceneGate.allowModelScene === false && sceneGate.triggered === true;
  const memoryFail = memoryGate.allowSharedMemoryClaim === false && memoryGate.triggered === true;
  const intimacyFail = intimacyGate.allowEscalation === false && Number(intimacyGate.intimacyScore || 0) > 0;
  const rewriteRequired = Boolean(superego.rewriteRequired);

  setText(
    "rtSceneGate",
    `sceneGate: ${stringifyCompact(sceneGate)}${sceneFail ? "  [FAIL]" : "  [PASS]"}`
  );
  setText(
    "rtMemoryGate",
    `memoryGate: ${stringifyCompact(memoryGate)}${memoryFail ? "  [FAIL]" : "  [PASS]"}`
  );
  setText(
    "rtIntimacyGate",
    `intimacyGate: ${stringifyCompact(intimacyGate)}${intimacyFail ? "  [FAIL]" : "  [PASS]"}`
  );
  setText(
    "rtSuperego",
    `superego: rewriteRequired=${rewriteRequired}, violations=${(superego.violations || []).join(", ") || "none"}`
  );
  setText(
    "rtRouting",
    `routing: history=${routing.historyLength}, speakers=${routing.speakerCount}, prompt=${routing.promptLength}, mode=${routing.chatMode}, current=${stringifyCompact(routing.currentSpeaker)}, target=${stringifyCompact(routing.targetSpeaker)}`
  );
  setText(
    "rtEcho",
    `echo: detected=${Boolean(runtimeLayer.echoDetected)}, regenerated=${Boolean(runtimeLayer.echoRegenerated)}, reason=${runtimeLayer.echoReason || "none"}`
  );
  setText("rtStateModel", `stateModel: ${stringifyCompact(stateModel)}`);
}

function refreshView(cog, thoughts) {
  setText("cognitionUpdated", `最後更新：${new Date().toLocaleTimeString("zh-TW", { hour12: false })}`);

  const mood = cog?.mood?.mood || thoughts?.currentMood || "--";
  const moodScore = thoughts?.moodScore ?? cog?.mood?.moodScore ?? "--";
  const drive = cog?.drive ?? thoughts?.drive ?? "--";
  const intent = cog?.activityIntent || thoughts?.currentIntent || "--";

  setText("moodValue", moodMap[mood] || mood);
  setText("moodScore", String(moodScore));
  setText("driveValue", String(drive));
  setText("intentValue", intentMap[intent] || intent);
  setText("activityWindow", cog?.activityWindowOpen ? "是" : "否");
  setText("activeChatCount", String(cog?.activeChatCount ?? "--"));
  setText("moodReason", cog?.mood?.reason || cog?.whyNow || thoughts?.whyNow || "--");

  setText("threadsUrge", String(thoughts?.threadsStatus?.urgeToScroll ?? "--"));
  setText("threadsLastScroll", formatRelativeMinutes(cog?.lastScrollAt || thoughts?.threadsStatus?.lastScrollAt));
  setText("unansweredInitiations", String(cog?.unansweredInitiations ?? "--"));
  setText("pausedChats", Array.isArray(cog?.pausedChats) && cog.pausedChats.length ? cog.pausedChats.join(", ") : "無");
  setText(
    "threadsSchedulerState",
    thoughts?.threadsStatus?.lastSchedulerResult?.reason || "無最近調度訊息"
  );

  const initiative = cog?.initiativeStatus || thoughts?.initiativeStatus || {};
  setText(
    "initiativeStatus",
    initiative.shouldInitiate
      ? `想主動：是 / 目標：${initiative.targetUserId || "unknown"} / 原因：${(initiative.reasonCodes || []).join(", ") || "none"}`
      : `想主動：否 / 原因：${(initiative.reasonCodes || []).join(", ") || "none"}`
  );

  setText("whyNow", cog?.whyNow || thoughts?.whyNow || "--");
  setText("lastTalkSummary", cog?.lastTalkSummary || thoughts?.lastTalkSummary || "--");

  renderList("recentInteractions", (cog?.lastInteractions || thoughts?.lastInteractions || []), formatInteraction, "目前沒有最近互動");
  renderList("emotionalEvents", (cog?.emotionalEvents || thoughts?.recentEmotionEvents || []), formatEmotionEvent, "目前沒有情緒事件");
  renderList("topFamiliarUsers", (cog?.topFamiliarUsers || thoughts?.topFamiliarUsers || []), formatFamiliar, "目前沒有熟悉度資料");

  renderRuntimeLayer(cog?.runtimeLayer || {});
}

async function loadAll() {
  const [cRes, tRes] = await Promise.all([
    authFetch("/api/ai-cognition"),
    authFetch("/api/ai-thoughts"),
  ]);
  if (!cRes.ok || !tRes.ok) throw new Error("api_failed");
  const [cog, thoughts] = await Promise.all([cRes.json(), tRes.json()]);
  refreshView(cog, thoughts);
}

async function refreshAll() {
  await loadAll();
}

async function bootstrap() {
  try {
    await ensureAuth();
    await loadAll();
    mergedInterval = setInterval(loadAll, 5000);
  } catch (_error) {
    if (mergedInterval) clearInterval(mergedInterval);
    document.body.innerHTML = `
      <main style="padding:24px;color:#e0e6ed;background:#0b1118;min-height:100vh;font-family:'Segoe UI',sans-serif">
        <h1>AI 認知監控</h1>
        <p>需要 superadmin 權限。</p>
      </main>
    `;
  }
}

bootstrap();
