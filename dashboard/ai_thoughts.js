let thoughtsInterval = null;

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
  idle: "發呆",
};

async function ensureAuth() {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get("teamToken") || "";
  let token = urlToken || localStorage.getItem("teamToken") || "";

  if (!token) {
    token = prompt("請輸入團隊 Token");
    if (!token) throw new Error("missing_token");
  }

  localStorage.setItem("teamToken", token);

  const res = await fetch("/api/me", {
    headers: { "x-team-token": token },
  });

  if (!res.ok) {
    localStorage.removeItem("teamToken");
    localStorage.removeItem("userRole");
    throw new Error("unauthorized");
  }

  const data = await res.json();
  localStorage.setItem("userRole", data.role);
  if (data.role !== "superadmin") throw new Error("forbidden");
}

// authFetch provided by auth.js (loaded before this script)

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatRelativeMinutes(timestamp) {
  if (!timestamp) return "尚未滑文";
  const value = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(value)) return "尚未滑文";
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000));
  return `${minutes} 分鐘前`;
}

function renderList(containerId, items, formatter, emptyText = "無資料") {
  const container = document.getElementById(containerId);
  if (!items || !items.length) {
    container.innerHTML = `<div class="card compact-card"><div class="value small">${escapeHtml(emptyText)}</div></div>`;
    return;
  }
  container.innerHTML = items.map((item, index) => {
    const content = formatter(item, index);
    return `<div class="card compact-card"><div class="value small">${content}</div></div>`;
  }).join("");
}

function formatInteraction(item, index) {
  return `${index + 1}. ${escapeHtml(item.nickname)} - ${escapeHtml(item.type || "互動")}`;
}

function formatFamiliar(item, index) {
  return `${index + 1}. ${escapeHtml(item.nickname)} - ${item.familiarity || 0}`;
}

function formatEmotion(item, index) {
  const delta = Number(item.delta || 0);
  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  return `${index + 1}. ${escapeHtml(sign)} ${escapeHtml(item.reason || item.type || "情緒變化")}`;
}

function formatInitiative(status = {}) {
  if (!status.shouldInitiate) {
    const reason = Array.isArray(status.reasonCodes) && status.reasonCodes.length
      ? status.reasonCodes.join(" / ")
      : "目前沒有主動開口的理由";
    return `暫時不主動\n原因：${reason}`;
  }

  return [
    "想主動開口",
    status.targetUserId ? `目標：${status.targetUserId}` : "目標：目前對話對象",
    status.initiativeContext?.lastTopic ? `上次話題：${status.initiativeContext.lastTopic}` : (status.initiativeContext?.topPreferenceTag ? `偏好標籤：${status.initiativeContext.topPreferenceTag}` : "背景：--"),
    Array.isArray(status.reasonCodes) ? `理由：${status.reasonCodes.join(" / ")}` : "理由：--",
  ].join("\n");
}

function refreshView(data) {
  document.getElementById("thoughtsUpdated").innerText =
    `最後更新：${new Date().toLocaleTimeString("zh-TW", { hour12: false })}`;

  document.getElementById("thoughtMood").innerText = moodMap[data.currentMood] || data.currentMood || "--";
  document.getElementById("thoughtMoodScore").innerText = String(data.moodScore ?? "--");
  document.getElementById("thoughtDrive").innerText = String(data.drive ?? "--");
  document.getElementById("thoughtIntent").innerText = intentMap[data.currentIntent] || data.currentIntent || "--";
  document.getElementById("thoughtWhyNow").innerText = data.whyNow || "先靜靜待著看看。";
  document.getElementById("lastTalkSummary").innerText = data.lastTalkSummary || "最近沒有新的聊天線索。";
  document.getElementById("initiativeStatus").innerText = formatInitiative(data.initiativeStatus || {});

  document.getElementById("threadsActive").innerText = data.threadsStatus?.activityWindowOpen ? "是" : "否";
  document.getElementById("threadsUrge").innerText = String(data.threadsStatus?.urgeToScroll ?? "--");
  document.getElementById("threadsLastScroll").innerText = formatRelativeMinutes(data.threadsStatus?.lastScrollAt);
  document.getElementById("threadsSchedulerState").innerText = data.threadsStatus?.lastSchedulerResult?.reason || "最近沒有新的滑文記錄";

  renderList("thoughtInteractions", data.lastInteractions || [], formatInteraction, "最近沒有互動");
  renderList("thoughtFamiliarUsers", data.topFamiliarUsers || [], formatFamiliar, "還沒有熟悉度資料");
  renderList("thoughtEmotionEvents", data.recentEmotionEvents || [], formatEmotion, "最近沒有情緒事件");
}

async function loadThoughts() {
  const res = await authFetch("/api/ai-thoughts");
  if (!res.ok) throw new Error(`api_failed_${res.status}`);
  const data = await res.json();
  refreshView(data);
}

async function refreshThoughts() {
  await loadThoughts();
}

async function bootstrap() {
  try {
    await ensureAuth();
    await loadThoughts();
    thoughtsInterval = setInterval(loadThoughts, 5000);
  } catch (_err) {
    if (thoughtsInterval) clearInterval(thoughtsInterval);
    document.body.innerHTML = `
      <main style="padding:24px;color:#e0e6ed;background:#0b1118;min-height:100vh;font-family:'Segoe UI',sans-serif">
        <h1>AI 內心 OS</h1>
        <p>只有 superadmin 可以查看這個頁面。</p>
      </main>
    `;
  }
}

bootstrap();
