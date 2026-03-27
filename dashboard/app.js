let intervalId = null;
let autoScroll = true;
let activeTab = "dashboard";
let logFilter = "all";
let chart = null;
let rawRealtimeLogs = [];
let rawActionLogs = [];
let authRole = null;

const modeLabelMap = {
  public_user_public: "公開使用者",
  developer_public: "開發者公開",
  developer_private_soft: "開發者私聊",
  unknown: "未知",
};

const reasonLabelMap = {
  direct_mention: "直接提及",
  question_detected: "偵測到問題",
  hostile_content: "攻擊內容",
  low_signal: "低訊號",
  default_ignore: "預設忽略",
  no_content: "無內容",
  no_action: "無行動",
  not_planned: "未規劃",
  auto_l1: "自動 L1",
};

async function ensureAuth() {
  const urlToken = new URLSearchParams(window.location.search).get("teamToken") || "";
  let token = urlToken || localStorage.getItem("teamToken") || "";

  if (!token) {
    token = prompt("請輸入團隊 Token");
    if (!token) {
      throw new Error("missing_token");
    }
    localStorage.setItem("teamToken", token);
  }

  const res = await fetch("/api/me", {
    headers: { "x-team-token": token },
  });

  if (!res.ok) {
    localStorage.removeItem("teamToken");
    localStorage.removeItem("userRole");
    throw new Error("unauthorized");
  }

  const data = await res.json();
  authRole = data.role;
  localStorage.setItem("userRole", data.role);
  return { token, role: data.role };
}

// authFetch is provided by auth.js (loaded before this script)

function hideElement(id) {
  const el = document.getElementById(id);
  if (el) {
    el.style.display = "none";
  }
}

function applyRoleUI(role) {
  if (role !== "superadmin") {
    hideElement("tabDashboard");
    hideElement("tabAiCognition");
    hideElement("dashboardView");
    hideElement("threadsActivityPanel");
    switchTab("analytics");
  }
}

function switchTab(tab) {
  activeTab = tab;
  document.getElementById("dashboardView").classList.toggle("active", tab === "dashboard");
  document.getElementById("analyticsView").classList.toggle("active", tab === "analytics");
  document.getElementById("tabDashboard").classList.toggle("active", tab === "dashboard");
  document.getElementById("tabAnalytics").classList.toggle("active", tab === "analytics");
  if (tab === "analytics" && chart) {
    chart.resize();
  }
}

function setLogFilter(filter) {
  logFilter = filter;
  document.getElementById("filterAll").classList.toggle("active", filter === "all");
  document.getElementById("filterPrivate").classList.toggle("active", filter === "private");
  document.getElementById("filterGroup").classList.toggle("active", filter === "group");
  renderLogs();
}

function colorize(value, element) {
  element.className = element.className.split(" ")[0] + " value";
  if (value > 0.2) element.classList.add("danger");
  else if (value > 0.05) element.classList.add("warning");
  else element.classList.add("success");
}

function colorizeHealth(score, element) {
  element.className = element.className.split(" ")[0] + " summary-chip";
  if (score >= 90) element.classList.add("success");
  else if (score >= 70) element.classList.add("warning");
  else element.classList.add("danger");
}

function formatPercent(value) {
  return `${((value || 0) * 100).toFixed(1)}%`;
}

function formatMap(map) {
  const entries = Object.entries(map || {});
  if (!entries.length) return "--";
  return entries.map(([key, value]) => `${translateLabel(key)}:${value}`).join(" | ");
}

function getTopKey(map) {
  const entries = Object.entries(map || {});
  if (!entries.length) return "--";
  return translateLabel(entries.sort((a, b) => b[1] - a[1])[0][0]);
}

function translateLabel(label) {
  if (!label) return "無";
  return modeLabelMap[label] || reasonLabelMap[label] || label;
}

function statusText(ok) {
  return ok ? "通過" : "失敗";
}

function formatUptime(sec) {
  const s = Math.floor(sec || 0);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function updateChart(history) {
  const labels = (history || []).map((point) => new Date(point.ts).toLocaleTimeString("zh-TW", { hour12: false }));
  const retryData = (history || []).map((point) => point.reflexRetryRate || 0);
  const artifactData = (history || []).map((point) => point.artifactRate || 0);
  const driftData = (history || []).map((point) => point.secondLineDriftRate || 0);
  const failData = (history || []).map((point) => point.reflexFailRate || 0);

  if (!chart) {
    chart = new Chart(document.getElementById("stabilityChart"), {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "重試率", data: retryData, borderColor: "#facc15", tension: 0.25 },
          { label: "異常殘留", data: artifactData, borderColor: "#60a5fa", tension: 0.25 },
          { label: "第二句漂移", data: driftData, borderColor: "#f87171", tension: 0.25 },
          { label: "Reflex 失敗率", data: failData, borderColor: "#4ade80", tension: 0.25 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: "#e0e6ed" } } },
        scales: {
          x: { ticks: { color: "#9aa4b2" }, grid: { color: "rgba(255,255,255,0.05)" } },
          y: {
            beginAtZero: true,
            ticks: { color: "#9aa4b2", callback: (value) => `${Math.round(value * 100)}%` },
            grid: { color: "rgba(255,255,255,0.05)" }
          }
        }
      }
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0].data = retryData;
    chart.data.datasets[1].data = artifactData;
    chart.data.datasets[2].data = driftData;
    chart.data.datasets[3].data = failData;
    chart.update();
  }
}

function renderAlerts(alerts, healthScore) {
  const box = document.getElementById("alertsBox");
  const header = document.getElementById("headerBar");

  if (!alerts || !alerts.length) {
    box.className = "alert-box compact";
    box.innerText = "目前沒有警示。";
    header.classList.remove("alert");
    return;
  }

  const isCritical = alerts.some((alert) => alert.startsWith("CRITICAL")) || healthScore < 70;
  box.className = isCritical ? "alert-box compact danger" : "alert-box compact warning";
  box.innerText = `系統異常\n${alerts.join("\n")}`;
  header.classList.add("alert");
}

function parseJsonLines(text) {
  return (text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return { raw: line, parsed: JSON.parse(line) };
      } catch {
        return { raw: line, parsed: null };
      }
    });
}

function mapChannel(entry) {
  const obj = entry?.parsed || {};
  if (obj.kind === "threads_activity") return "threads";
  const channel = obj.channel;
  if (channel === "private") return "private";
  if (channel === "group") return "group";
  return "group";
}

function filterLogs(entries) {
  if (logFilter === "all") return entries;
  return entries.filter((entry) => mapChannel(entry) === logFilter);
}

function formatLogLine(entry) {
  if (!entry.parsed) {
    return { text: entry.raw, cssClass: "group" };
  }

  const obj = entry.parsed;
  const ts = obj.timestamp ? new Date(obj.timestamp).toLocaleTimeString("zh-TW", { hour12: false }) : "--:--:--";
  const stage = obj.stage || obj.kind || "事件";
  const channel = mapChannel(entry);
  const role = obj.role || "-";
  const reason = translateLabel(obj.reason || obj.engageDecision?.reason || obj.riskDecision?.reason || "");
  const text = obj.text || obj.replyText || obj.content || obj.intent || "";
  const stageLabel = translateStage(stage);
  const channelLabelMap = { private: "私聊", group: "群組", threads: "Threads" };
  const channelLabel = channelLabelMap[channel] || "群組";
  const summary = [ts, `[${stageLabel}]`, `[${channelLabel}]`, role !== "-" ? `[${translateLabel(role)}]` : "", reason, text].filter(Boolean).join(" ");
  const cssClass = `${channel} ${stage.includes("error") || stage === "send_error" ? "error" : stage}`;
  return { text: summary, cssClass };
}

function renderLogBox(containerId, entries) {
  const container = document.getElementById(containerId);
  const filtered = filterLogs(entries);
  container.innerHTML = filtered.length
    ? filtered.map((entry) => {
        const line = formatLogLine(entry);
        return `<div class="log-line ${line.cssClass}">${escapeHtml(line.text)}</div>`;
      }).join("")
    : '<div class="log-line">--</div>';

  if (autoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function mergeLogs() {
  return [...rawRealtimeLogs, ...rawActionLogs].sort((a, b) => {
    const ta = a.parsed?.timestamp ? Date.parse(a.parsed.timestamp) : 0;
    const tb = b.parsed?.timestamp ? Date.parse(b.parsed.timestamp) : 0;
    return ta - tb;
  });
}

function renderLogs() {
  renderLogBox("logContainer", mergeLogs());
}

function translateStage(stage) {
  const map = {
    incoming: "接收",
    reply: "回覆",
    decision: "決策",
    execution: "執行",
    connected: "連線",
    error: "錯誤",
    send_error: "送出失敗",
    send_success: "送出成功",
    event: "事件",
    threads_session_start: "Threads 開始滑文",
    threads_session_end: "Threads 滑文結束",
    threads_like: "Threads 按讚",
    threads_reply: "Threads 留言",
    moderation_queue: "送審核",
  };
  return map[stage] || stage;
}

async function loadMetrics() {
  const endpoint = authRole === "superadmin" ? "/api/metrics" : "/api/analysis-summary";
  const res = await authFetch(endpoint);
  const data = await res.json();

  if (authRole !== "superadmin") {
    const actions = data.actions || {};
    const regressions = data.regressions || {};
    const queue = data.queue || {};

    document.getElementById("systemTime").innerText = `系統時間：${data.system?.timestamp || "--"}`;
    document.getElementById("uptime").innerText = "運行時間：受限";
    document.getElementById("lastUpdated").innerText = `最後更新：${new Date().toLocaleTimeString("zh-TW", { hour12: false })}`;

    document.getElementById("currentPersonaMode").innerText = getTopKey(actions.persona_mode_dist);
    document.getElementById("personaModeDist").innerText = formatMap(actions.persona_mode_dist || {});
    document.getElementById("topIgnoreReason").innerText = translateLabel(actions.top_ignore_reason);
    document.getElementById("topEngageReason").innerText = translateLabel(actions.top_engage_reason);

    document.getElementById("pendingReview").innerText = String(actions.pending_review || queue.pending || 0);
    document.getElementById("actionTotal").innerText = String(queue.total || 0);

    const engageRate = document.getElementById("engageRate");
    engageRate.innerText = formatPercent(actions.engage_rate);
    colorize(actions.engage_rate || 0, engageRate);

    const ignoreRate = document.getElementById("ignoreRate");
    ignoreRate.innerText = formatPercent(actions.ignore_rate);
    colorize(actions.ignore_rate || 0, ignoreRate);

    const hostileIgnoreRate = document.getElementById("hostileIgnoreRate");
    hostileIgnoreRate.innerText = formatPercent(actions.hostile_ignore_rate);
    colorize(1 - (actions.hostile_ignore_rate || 0), hostileIgnoreRate);

    const lowSignalIgnoreRate = document.getElementById("lowSignalIgnoreRate");
    lowSignalIgnoreRate.innerText = formatPercent(actions.low_signal_ignore_rate);
    colorize(1 - (actions.low_signal_ignore_rate || 0), lowSignalIgnoreRate);

    const personaRegression = regressions.persona || {};
    const engageRegression = regressions.engage || {};
    const personaPass = personaRegression.personaModeAccuracy === 1 && personaRegression.publicSpoofRate === 1 && (personaRegression.developerPrivateQuestionRate || 0) <= 0.2;
    const publicSummary = engageRegression.summary?.public_user_public || {};
    const privateSummary = engageRegression.summary?.developer_private_soft || {};
    const engagePass = (publicSummary.hostile_ignore_rate || 0) >= 0.8 && (publicSummary.low_signal_ignore_rate || 0) >= 0.8 && (privateSummary.hostile_ignore_rate || 0) >= 0.8;

    document.getElementById("personaHealthCompact").innerText = `人格 ${statusText(personaPass)} | 模式 ${translateLabel(getTopKey(actions.persona_mode_dist))}`;
    document.getElementById("engageCompact").innerText = `互動 ${formatPercent(actions.engage_rate)} | 忽略 ${formatPercent(actions.ignore_rate)} | 主因 ${translateLabel(actions.top_engage_reason)}`;
    document.getElementById("riskCompact").innerText = `待審核:${queue.pending || 0} | 已通過:${queue.approved || 0} | 已拒絕:${queue.rejected || 0}`;
    document.getElementById("regressionCompact").innerText = `人格 ${statusText(personaPass)} | 過濾 ${statusText(engagePass)}`;
    document.getElementById("rollingCompact").innerText = "團隊模式：僅分析與審核";

    document.getElementById("privateTrustCheck").innerText = "團隊模式：無系統總覽權限";
    document.getElementById("privateTrustCheck").className = "value small warning";
    document.getElementById("alertsBox").className = "alert-box compact";
    document.getElementById("alertsBox").innerText = "團隊模式：系統總覽與日誌已隔離。";
    document.getElementById("connectorStatus").innerText = "● 受限";
    document.getElementById("incomingRate").innerText = "團隊模式";
    document.getElementById("errorRate").innerText = "系統資訊已隔離";
    document.getElementById("healthScore").innerText = "健康：受限";
    updateChart([]);
    return;
  }

  const tg = data.connector?.tg || {};
  const reflex = data.reflex || {};
  const rolling = data.rolling || {};
  const actions = data.actions || {};
  const memory = data.memory || {};
  const conversation = data.conversation || {};
  const regressions = data.regressions || {};
  const healthScore = Number(data.healthScore || 0);

  const connectorStatus = document.getElementById("connectorStatus");
  connectorStatus.innerText = tg.online ? "● 在線" : "● 離線";
  connectorStatus.className = tg.online ? "summary-chip success" : "summary-chip danger";

  document.getElementById("incomingRate").innerText = `${tg.incoming_last_min || 0} 次/分`;
  document.getElementById("errorRate").innerText = `錯誤：${tg.errors_last_min || 0}`;
  const healthChip = document.getElementById("healthScore");
  healthChip.innerText = `健康：${healthScore.toFixed(1)}`;
  colorizeHealth(healthScore, healthChip);

  const reflexRate = document.getElementById("reflexRate");
  reflexRate.innerText = formatPercent(reflex.reflexTriggerRate);
  colorize(reflex.reflexTriggerRate || 0, reflexRate);

  const retryRate = document.getElementById("retryRate");
  retryRate.innerText = formatPercent(reflex.reflexRetryRate);
  colorize(reflex.reflexRetryRate || 0, retryRate);

  const artifactRate = document.getElementById("artifactRate");
  artifactRate.innerText = formatPercent(reflex.artifactTrend);
  colorize(reflex.artifactTrend || 0, artifactRate);

  const secondDrift = document.getElementById("secondDrift");
  secondDrift.innerText = formatPercent(reflex.secondLineDriftRate);
  colorize(reflex.secondLineDriftRate || 0, secondDrift);

  const reflexFail = document.getElementById("reflexFail");
  reflexFail.innerText = formatPercent(rolling.reflexFailRate);
  colorize(rolling.reflexFailRate || 0, reflexFail);

  const topicPersistence = document.getElementById("topicPersistence");
  topicPersistence.innerText = formatPercent(conversation.topicPersistence);
  colorize(conversation.topicPersistence || 0, topicPersistence);
  const avgQuestionRatio = document.getElementById("avgQuestionRatio");
  avgQuestionRatio.innerText = formatPercent(conversation.avgQuestionRatio);
  colorize(conversation.avgQuestionRatio || 0, avgQuestionRatio);
  document.getElementById("consecutiveQuestionCount").innerText = String(conversation.consecutiveQuestionCount || 0);
  document.getElementById("modeDistribution").innerText = formatMap(conversation.modeDistribution || {});

  document.getElementById("windowSize").innerText = String(rolling.size || 0);
  const devClaimObserved = document.getElementById("devClaimObserved");
  devClaimObserved.innerText = formatPercent(rolling.devClaimObservedRate);
  colorize(rolling.devClaimObservedRate || 0, devClaimObserved);
  document.getElementById("reflexPathDist").innerText = formatMap(rolling.reflexPathDist || reflex.reflexPathDist || {});

  document.getElementById("currentPersonaMode").innerText = getTopKey(actions.persona_mode_dist);
  document.getElementById("personaModeDist").innerText = formatMap(actions.persona_mode_dist || {});

  const spoofAttemptRate = document.getElementById("spoofAttemptRate");
  spoofAttemptRate.innerText = formatPercent(actions.spoof_attempt_rate);
  colorize(actions.spoof_attempt_rate || 0, spoofAttemptRate);

  const devPrivateQuestionRate = document.getElementById("devPrivateQuestionRate");
  devPrivateQuestionRate.innerText = formatPercent(actions.dev_private_question_rate);
  colorize(actions.dev_private_question_rate || 0, devPrivateQuestionRate);

  const hostileIgnoreRate = document.getElementById("hostileIgnoreRate");
  hostileIgnoreRate.innerText = formatPercent(actions.hostile_ignore_rate);
  colorize(1 - (actions.hostile_ignore_rate || 0), hostileIgnoreRate);

  const lowSignalIgnoreRate = document.getElementById("lowSignalIgnoreRate");
  lowSignalIgnoreRate.innerText = formatPercent(actions.low_signal_ignore_rate);
  colorize(1 - (actions.low_signal_ignore_rate || 0), lowSignalIgnoreRate);

  document.getElementById("actionTotal").innerText = String(actions.recent_total || 0);
  document.getElementById("pendingReview").innerText = String(actions.pending_review || 0);

  const engageRate = document.getElementById("engageRate");
  engageRate.innerText = formatPercent(actions.engage_rate);
  colorize(actions.engage_rate || 0, engageRate);

  const ignoreRate = document.getElementById("ignoreRate");
  ignoreRate.innerText = formatPercent(actions.ignore_rate);
  colorize(actions.ignore_rate || 0, ignoreRate);

  document.getElementById("topIgnoreReason").innerText = translateLabel(actions.top_ignore_reason);
  document.getElementById("topEngageReason").innerText = translateLabel(actions.top_engage_reason);
  document.getElementById("riskBreakdown").innerText = `L0:${actions.L0 || 0} | L1:${actions.L1 || 0} | L2:${actions.L2 || 0} | L3:${actions.L3 || 0} | 審核:${actions.threads_pending || 0}`;

  document.getElementById("memoryActiveKeys").innerText = String(memory.activeKeys || 0);
  document.getElementById("memoryShortAvg").innerText = String(memory.avgShortTermLength || 0);
  document.getElementById("memoryFacts").innerText = String(memory.totalLongTermFacts || 0);
  document.getElementById("memoryLargestKey").innerText = memory.largestKey || "無";

  const personaRegression = regressions.persona || {};
  const personaPass = personaRegression.personaModeAccuracy === 1 && personaRegression.publicSpoofRate === 1 && (personaRegression.developerPrivateQuestionRate || 0) <= 0.2;
  const engageRegression = regressions.engage || {};
  const publicSummary = engageRegression.summary?.public_user_public || {};
  const privateSummary = engageRegression.summary?.developer_private_soft || {};
  const engagePass = (publicSummary.hostile_ignore_rate || 0) >= 0.8 && (publicSummary.low_signal_ignore_rate || 0) >= 0.8 && (privateSummary.hostile_ignore_rate || 0) >= 0.8;

  document.getElementById("personaHealthCompact").innerText = `觸發 ${formatPercent(reflex.reflexTriggerRate)} | 漂移 ${formatPercent(reflex.secondLineDriftRate)} | 失敗 ${formatPercent(rolling.reflexFailRate)} | 回歸 ${statusText(personaPass)}`;
  document.getElementById("engageCompact").innerText = `互動 ${formatPercent(actions.engage_rate)} | 忽略 ${formatPercent(actions.ignore_rate)} | 主因 ${translateLabel(actions.top_engage_reason)}`;
  document.getElementById("riskCompact").innerText = `L0:${actions.L0 || 0} | L1:${actions.L1 || 0} | L2:${actions.L2 || 0} | L3:${actions.L3 || 0} | 審核:${actions.threads_pending || 0}`;
  document.getElementById("regressionCompact").innerText = `人格 ${statusText(personaPass)} | 過濾 ${statusText(engagePass)}`;
  document.getElementById("rollingCompact").innerText = `視窗 ${rolling.size || 0} | 開發者 ${formatPercent(rolling.devClaimObservedRate)} | 重試 ${formatPercent(rolling.reflexRetryRate)}`;

  const trustCheck = document.getElementById("privateTrustCheck");
  const trustPass = !actions.persona_mode_dist?.unknown && (actions.persona_mode_dist?.developer_private_soft || 0) <= (actions.recent_total || 0);
  trustCheck.innerText = trustPass ? "通過 | 僅信任 Telegram / threads_dm 私聊" : "失敗 | 私聊邊界異常";
  trustCheck.className = trustPass ? "value small success" : "value small danger";

  document.getElementById("systemTime").innerText = `系統時間：${data.system?.timestamp || "--"}`;
  document.getElementById("uptime").innerText = `運行時間：${formatUptime(data.system?.uptime_sec)}`;
  document.getElementById("lastUpdated").innerText = `最後更新：${new Date().toLocaleTimeString("zh-TW", { hour12: false })}`;

  renderAlerts(data.alerts || [], healthScore);
  updateChart(data.history || []);
}

async function loadLog() {
  if (authRole !== "superadmin") return;
  try {
    const res = await authFetch("/api/log");
    if (!res.ok) throw new Error(res.status);
    const text = await res.text();
    rawRealtimeLogs = parseJsonLines(text);
    renderLogs();
  } catch { /* non-blocking */ }
}

async function loadActionLog() {
  if (authRole !== "superadmin") return;
  try {
    const res = await authFetch("/api/action-log");
    if (!res.ok) throw new Error(res.status);
    const text = await res.text();
    rawActionLogs = parseJsonLines(text);
    renderLogs();
  } catch { /* non-blocking */ }
}

function formatRelativeTime(ts) {
  if (!ts) return "--";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return "剛才";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分鐘前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小時前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

async function loadThreadsActivity() {
  if (authRole !== "superadmin") return;
  try {
    const res = await authFetch("/api/threads-activity");
    if (!res.ok) return;
    const data = await res.json();

    const sessionEl = document.getElementById("threadsLastSession");
    if (data.lastSession) {
      sessionEl.innerText = `${formatRelativeTime(data.lastSession.timestamp)}｜按讚 ${data.lastSession.actionsPerformed} 次 / 看 ${data.lastSession.postsEvaluated} 則`;
    } else {
      sessionEl.innerText = "尚未執行";
    }

    const likeEl = document.getElementById("threadsLastLike");
    if (data.lastLike) {
      const author = data.lastLike.author ? `@${data.lastLike.author} ` : "";
      likeEl.innerText = `${formatRelativeTime(data.lastLike.timestamp)}｜${author}共鳴 ${data.lastLike.score ?? "--"}`;
    } else {
      likeEl.innerText = "尚未按讚";
    }

    const commentEl = document.getElementById("threadsLastComment");
    if (data.lastCommentQueued) {
      const author = data.lastCommentQueued.author ? `@${data.lastCommentQueued.author} ` : "";
      commentEl.innerText = `${formatRelativeTime(data.lastCommentQueued.timestamp)}｜${author}${String(data.lastCommentQueued.text || "").slice(0, 30)}`;
    } else {
      commentEl.innerText = "尚未提議留言";
    }

    const queueEl = document.getElementById("threadsQueueStatus");
    const proposalNote = data.commentProposalCount > 0 ? ` (留言 ${data.commentProposalCount})` : "";
    queueEl.innerText = `待審核：${data.pending} ｜ 已通過：${data.approved}${proposalNote}`;
  } catch { /* ignore */ }
}

async function loadThreadsImpressions() {
  if (authRole !== "superadmin") return;
  try {
    const res = await authFetch("/api/threads-impressions");
    if (!res.ok) return;
    const data = await res.json();
    const authorsEl = document.getElementById("threadsTopAuthors");
    if (!authorsEl) return;
    const top = (data.topAuthors || []).slice(0, 3);
    if (!top.length) {
      authorsEl.innerText = "尚無記錄";
      return;
    }
    authorsEl.innerText = top
      .map((a) => `@${a.username} ×${a.likeCount}`)
      .join("  ");
  } catch { /* ignore */ }
}

function copyLog() {
  const filtered = filterLogs(mergeLogs()).map((entry) => formatLogLine(entry).text).join("\n");
  navigator.clipboard.writeText(filtered);
}

function clearLog() {
  rawActionLogs = [];
  rawRealtimeLogs = [];
  renderLogs();
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  document.getElementById("autoScrollButton").innerText = `自動滾動：${autoScroll ? "開" : "關"}`;
}

function runAllLoaders() {
  return Promise.all([
    loadMetrics().catch(() => {}),
    loadLog().catch(() => {}),
    loadActionLog().catch(() => {}),
    loadThreadsActivity().catch(() => {}),
    loadThreadsImpressions().catch(() => {}),
  ]);
}

function setRefresh(rate) {
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(() => { runAllLoaders(); }, rate);
}

function manualRefresh() {
  const btn = document.querySelector('.topbar-nav .btn[onclick="manualRefresh()"]');
  if (btn) { btn.textContent = '刷新中…'; btn.disabled = true; }
  runAllLoaders().finally(() => {
    if (btn) { btn.textContent = '刷新'; btn.disabled = false; }
  });
}

document.getElementById("refreshRate").addEventListener("change", (event) => {
  setRefresh(parseInt(event.target.value, 10));
});

async function bootstrap() {
  try {
    const auth = await ensureAuth();
    applyRoleUI(auth.role);
    setRefresh(10000);
    await loadMetrics();
    await loadLog();
    await loadActionLog();
    await loadThreadsActivity();
    await loadThreadsImpressions();
  } catch (err) {
    document.body.innerHTML = `<main style="padding:24px;color:#e0e6ed;background:#0b1118;min-height:100vh;font-family:'Segoe UI',sans-serif"><h1>授權失敗</h1><p>請重新整理並輸入有效團隊 Token。</p></main>`;
  }
}

bootstrap();
