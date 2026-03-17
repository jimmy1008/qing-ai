let moderationRole = null;

function formatTime(ts) {
  if (!ts) return "--";
  return new Date(ts).toLocaleString("zh-TW", { hour12: false });
}

function riskRank(level) {
  return { L0: 0, L1: 1, L2: 2, L3: 3 }[level] ?? 99;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function proposalTypeLabel(type) {
  if (type === "reply_self_post") return "SELF";
  if (type === "reply_external_post") return "EXTERNAL";
  return "GENERAL";
}

function proposalTypeText(type) {
  if (type === "reply_self_post") return "回覆自己貼文";
  if (type === "reply_external_post") return "回覆他人貼文";
  return "一般提案";
}

function renderContextBlock(title, username, content, url) {
  const safeContent = escapeHtml(content || "");
  const safeUsername = escapeHtml(username || "--");
  const link = url
    ? `<a class="btn btn-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">查看原文</a>`
    : "";

  if (!safeContent && !link) return "";

  return `
    <div class="context-block">
      <div class="context-title">${title}（@${safeUsername}）</div>
      <div class="context-body">${safeContent || "—"}</div>
      ${link ? `<div class="context-link">${link}</div>` : ""}
    </div>
  `;
}

async function ensureModerationAuth() {
  const urlToken = new URLSearchParams(window.location.search).get("teamToken") || "";
  let token = urlToken || localStorage.getItem("teamToken") || "";

  if (!token) {
    token = prompt("請輸入 Team Token");
    if (!token) {
      throw new Error("missing_token");
    }
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
  moderationRole = data.role;
  localStorage.setItem("userRole", data.role);
  document.getElementById("roleBadge").innerText =
    data.role === "superadmin" ? "目前角色：超級管理員" : "目前角色：審核員";
}

// moderationFetch → alias to authFetch (provided by auth.js)
const moderationFetch = authFetch;

function setPageError(message) {
  const container = document.getElementById("moderationList");
  container.innerHTML = `<div class="card compact-card">${message}</div>`;
}

async function loadExternalRateStatus() {
  const res = await moderationFetch("/api/threads/external-rate-status");
  if (!res.ok) return;

  const data = await res.json();
  const summary = document.getElementById("externalRateSummary");
  const badge = document.getElementById("externalRateBadge");

  if (summary) {
    summary.innerText = `External Rate（AI Initiated Only）：本小時 ${data.hourCount} / ${data.hourLimit}｜今日 ${data.dayCount} / ${data.dayLimit}`;
  }

  if (badge) {
    badge.innerText = data.limitReached ? "LIMIT REACHED" : "OK";
    badge.className = `summary-chip ${data.limitReached ? "danger" : "success"}`;
  }
}

async function approveItem(id) {
  const approvedBy = prompt("請輸入核准者 userId", "5686223888");
  if (approvedBy === null) return;

  const res = await moderationFetch(`/api/threads-moderation/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approvedBy }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "approve failed" }));
    alert(err.error || "approve failed");
    return;
  }

  await loadQueue();
}

async function rejectItem(id) {
  const rejectedBy = prompt("請輸入拒絕者 userId", "5686223888");
  if (rejectedBy === null) return;

  const reason = prompt("請輸入拒絕原因", "manual reject") || "";
  const res = await moderationFetch(`/api/threads-moderation/${id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rejectedBy, reason }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "reject failed" }));
    alert(err.error || "reject failed");
    return;
  }

  await loadQueue();
}

async function editItem(id, currentContent) {
  const editedContent = prompt("請修改內容", currentContent || "");
  if (editedContent === null) return;

  const res = await moderationFetch(`/api/threads-moderation/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ editedContent }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "edit failed" }));
    alert(err.error || "edit failed");
    return;
  }

  await loadQueue();
}

async function regenerateItem(id) {
  const res = await moderationFetch(`/api/threads-moderation/${id}/regenerate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "regenerate failed" }));
    alert(err.error || "regenerate failed");
    return;
  }

  await loadQueue();
}

function renderCard(item) {
  return `
    <div class="card moderation-item">
      <div class="moderation-head">
        <div class="moderation-head-left">
          <div class="card-title">${item.type} | ${item.platform}</div>
          <div class="summary-chip subtle-chip">${proposalTypeText(item.proposalType)}</div>
        </div>
        <div class="summary-chip ${item.riskLevel === "L3" ? "danger" : item.riskLevel === "L2" ? "warning" : "success"}">${item.riskLevel}</div>
      </div>
      <div class="moderation-meta">
        <span>人格模式：${item.personaMode || "--"}</span>
        <span>語氣：${item.toneProfile || "--"}</span>
        <span>目標貼文：${item.targetPostId || "--"}</span>
        <span>建立時間：${formatTime(item.updatedAt || item.createdAt)}</span>
        <span>狀態：${item.status}</span>
      </div>
      ${renderContextBlock(
        "原貼文",
        item.originalPost?.authorUsername,
        item.originalPost?.content,
        item.originalPost?.url,
      )}
      ${item.originalComment ? renderContextBlock(
        "原留言",
        item.originalComment?.username,
        item.originalComment?.content,
        null,
      ) : ""}
      <pre class="moderation-content">${escapeHtml(item.editedContent || item.content || "")}</pre>
      <div class="moderation-actions">
        ${item.status === "pending" ? `
          <button class="btn btn-approve" type="button" onclick="approveItem('${item.id}')">核准</button>
          <button class="btn btn-edit" type="button" onclick="editItem('${item.id}', ${JSON.stringify(item.editedContent || item.content || "")})">編輯</button>
          <button class="btn btn-edit" type="button" onclick="regenerateItem('${item.id}')">重新生成</button>
          <button class="btn btn-reject" type="button" onclick="rejectItem('${item.id}')">拒絕</button>
        ` : ""}
      </div>
    </div>
  `;
}

function renderColumn(containerId, countId, items, emptyText) {
  const container = document.getElementById(containerId);
  const countEl = document.getElementById(countId);
  if (countEl) countEl.innerText = items.length ? `${items.length}` : "";
  container.innerHTML = items.length
    ? items.map(renderCard).join("")
    : `<div class="card compact-card"><div class="value small">${emptyText}</div></div>`;
}

function renderItems(items) {
  const selfItems = items.filter((i) => i.proposalType === "reply_self_post");
  const externalItems = items.filter((i) => i.proposalType !== "reply_self_post");
  renderColumn("selfReplyList", "selfReplyCount", selfItems, "目前沒有待審核項目");
  renderColumn("externalReplyList", "externalReplyCount", externalItems, "目前沒有待審核項目");
}

async function loadQueue() {
  const status = document.getElementById("statusFilter").value;
  const sortBy = document.getElementById("sortBy").value;
  const res = await moderationFetch(`/api/threads-moderation?status=${encodeURIComponent(status)}&sortBy=${encodeURIComponent(sortBy)}`);

  if (!res.ok) {
    if (res.status === 403) {
      throw new Error("forbidden");
    }
    throw new Error("queue_load_failed");
  }

  const data = await res.json();
  document.getElementById("moderationSummary").innerText =
    `待審核：${data.stats.pending} | 已核准：${data.stats.approved} | 已拒絕：${data.stats.rejected}`;
  document.getElementById("moderationUpdated").innerText =
    `最後更新：${new Date().toLocaleString("zh-TW", { hour12: false })}`;

  const sorted = data.items.slice().sort((a, b) => {
    if (sortBy === "riskLevel") {
      return riskRank(a.riskLevel) - riskRank(b.riskLevel);
    }
    return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
  });

  renderItems(sorted);
  await loadExternalRateStatus();
}

async function bootstrapModerationPage() {
  try {
    await ensureModerationAuth();
    await loadQueue();
    setInterval(() => {
      loadQueue().catch(() => {});
    }, 15000);
  } catch (err) {
    const message =
      err.message === "unauthorized" || err.message === "forbidden"
        ? "沒有權限，請重新輸入有效的 Team Token。"
        : "Threads 審核頁載入失敗。";
    setPageError(message);
  }
}

bootstrapModerationPage();
