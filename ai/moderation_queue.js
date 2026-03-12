const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { notifySuperAdmin } = require("../connectors/telegram/notifier");

const QUEUE_PATH = path.join(__dirname, "../telemetry/threads_moderation_queue.json");
const AUDIT_LOG_PATH = path.join(__dirname, "../logs/moderation_audit.log");

function ensureStorage() {
  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
  if (!fs.existsSync(QUEUE_PATH)) {
    fs.writeFileSync(QUEUE_PATH, "[]", { encoding: "utf8" });
  }
}

function readQueue() {
  ensureStorage();
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function writeQueue(items) {
  ensureStorage();
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(items, null, 2), { encoding: "utf8" });
}

function appendAudit(entry) {
  ensureStorage();
  fs.appendFileSync(
    AUDIT_LOG_PATH,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
    { encoding: "utf8" },
  );
}

function normalizePlatform(actionProposal = {}, event = {}) {
  if (actionProposal.platform) return actionProposal.platform;
  if (event.platform) return event.platform;
  if (String(event.connector || "").startsWith("threads")) return "threads";
  return "unknown";
}

function forceMention(content, event = {}) {
  if (normalizePlatform({}, event) !== "threads") return String(content || "").trim();

  const username =
    event.platformUserRef?.username
    || event.raw?.username
    || event.actor?.username
    || event.username
    || event.authorUsername
    || null;

  const text = String(content || "").trim();
  if (!username) return text;

  const mention = `@${String(username).replace(/^@+/, "")}`;
  if (!text) return mention;
  if (text.startsWith(mention)) return text;
  if (text.includes(mention)) return text;
  return `${mention} ${text}`.trim();
}

function buildSourceEventSnapshot(event = {}) {
  if (!event || typeof event !== "object") return null;
  return {
    type: event.type || null,
    platform: event.platform || null,
    connector: event.connector || null,
    channel: event.channel || null,
    chatType: event.chatType || null,
    chatId: event.chatId || null,
    postId: event.postId || event.targetPostId || event.target || null,
    targetPostId: event.targetPostId || event.postId || null,
    targetUrl: event.targetUrl || null,
    commentId: event.commentId || null,
    userId: event.userId || null,
    username: event.username || event.authorUsername || null,
    authorUsername: event.authorUsername || event.username || null,
    content: event.content || event.text || "",
    text: event.text || event.content || "",
    personaModeKey: event.personaModeKey || null,
    toneStyle: event.toneStyle || null,
    postOwnerId: event.postOwnerId || null,
    originalPost: event.originalPost || null,
    originalComment: event.originalComment || null,
    interactionSource: event.interactionSource || null,
    platformUserRef: event.platformUserRef || (
      event.username || event.authorUsername
        ? {
            platform: event.platform || normalizePlatform({}, event),
            userId: event.userId || null,
            username: event.username || event.authorUsername || null,
          }
        : null
    ),
    raw: event.raw || null,
  };
}

function enqueueModeration(actionProposal, event = {}, riskDecision = {}) {
  const finalContent = forceMention(actionProposal.content || "", event);
  console.log("RAW_PROPOSAL_TEXT:", finalContent);
  const queue = readQueue();
  const entry = {
    id: crypto.randomUUID(),
    platform: normalizePlatform(actionProposal, event),
    type: actionProposal.action || "unknown",
    proposalType: actionProposal.proposalType || null,
    interactionSource: actionProposal.interactionSource || event.interactionSource || null,
    content: finalContent,
    targetPostId: actionProposal.target || null,
    targetUrl: actionProposal.targetUrl || event.targetUrl || null,
    personaMode: event.personaModeKey || null,
    toneProfile: event.toneStyle || null,
    riskLevel: actionProposal.risk_level || "L1",
    injectionFlag: Boolean(event.injectionDetected),
    createdAt: Date.now(),
    status: "pending",
    connector: event.connector || null,
    channel: event.channel || null,
    userId: event.userId || null,
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectReason: null,
    originalContent: finalContent,
    editedContent: finalContent,
    originalPost: actionProposal.originalPost || event.originalPost || null,
    originalComment: actionProposal.originalComment || event.originalComment || null,
    riskDecision,
    execution: null,
    sourceEvent: buildSourceEventSnapshot(event),
    updatedAt: null,
  };

  queue.push(entry);
  writeQueue(queue);
  appendAudit({
    kind: "enqueue",
    id: entry.id,
    platform: entry.platform,
    type: entry.type,
    riskLevel: entry.riskLevel,
    personaMode: entry.personaMode,
  });

  const notifTarget = entry.sourceEvent?.username || entry.sourceEvent?.authorUsername || "(unknown)";
  if (entry.riskLevel === "L3") {
    const msg = [
      `⚠️ *L3 高風險待審核*`,
      `類型: \`${entry.type}\``,
      `對象: @${notifTarget}`,
      `平台: ${entry.platform}`,
      `ID: \`${entry.id}\``,
      ``,
      `審核頁：/threads-moderation`,
    ].join("\n");
    notifySuperAdmin(msg).catch(() => {});
  } else if (riskDecision.allowed === false) {
    const preview = String(finalContent || "").slice(0, 60);
    const msg = [
      `📋 *新審核項目（${entry.riskLevel}）*`,
      `類型: ${entry.type}`,
      `對象: @${notifTarget}`,
      preview ? `內容: ${preview}` : null,
      `審核頁：/threads-moderation`,
    ].filter(Boolean).join("\n");
    notifySuperAdmin(msg).catch(() => {});
  }

  return entry;
}

function listQueue(status = null) {
  const queue = readQueue();
  if (!status || status === "all") return queue;
  return queue.filter((item) => item.status === status);
}

function getQueueItem(id) {
  return readQueue().find((item) => item.id === id) || null;
}

function updateQueueItem(id, updater) {
  const queue = readQueue();
  const index = queue.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const current = queue[index];
  const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
  queue[index] = next;
  writeQueue(queue);
  return next;
}

function editQueueItem(id, editedContent) {
  const updated = updateQueueItem(id, (item) => ({
    ...item,
    editedContent: typeof editedContent === "string" ? editedContent : item.editedContent,
    updatedAt: Date.now(),
  }));
  if (updated) {
    appendAudit({
      kind: "edit",
      id: updated.id,
      platform: updated.platform,
      editedContent: updated.editedContent,
    });
  }
  return updated;
}

function regenerateQueueItem(id, patch = {}) {
  const updated = updateQueueItem(id, (item) => {
    const sourceEvent = { ...(item.sourceEvent || {}), ...(patch.sourceEvent || {}) };
    const nextContent = forceMention(
      typeof patch.content === "string" ? patch.content : item.content,
      sourceEvent,
    );

    return {
      ...item,
      content: nextContent,
      editedContent: nextContent,
      personaMode: patch.personaMode || item.personaMode,
      toneProfile: patch.toneProfile || item.toneProfile,
      sourceEvent,
      updatedAt: Date.now(),
    };
  });

  if (updated) {
    appendAudit({
      kind: "regenerate",
      id: updated.id,
      platform: updated.platform,
      toneProfile: updated.toneProfile,
      personaMode: updated.personaMode,
      content: updated.content,
    });
  }

  return updated;
}

function approveQueueItem(id, approvedBy, execution = null) {
  const updated = updateQueueItem(id, (item) => ({
    ...item,
    status: "approved",
    approvedBy: approvedBy || null,
    approvedAt: Date.now(),
    execution: execution || item.execution,
  }));
  if (updated) {
    appendAudit({
      kind: "approve",
      id: updated.id,
      platform: updated.platform,
      approvedBy: updated.approvedBy,
      approvedAt: updated.approvedAt,
      originalContent: updated.originalContent,
      editedContent: updated.editedContent,
      riskLevel: updated.riskLevel,
      execution,
    });
  }
  return updated;
}

function rejectQueueItem(id, rejectedBy, rejectReason = "") {
  const updated = updateQueueItem(id, (item) => ({
    ...item,
    status: "rejected",
    rejectedBy: rejectedBy || null,
    rejectedAt: Date.now(),
    rejectReason: rejectReason || null,
  }));
  if (updated) {
    appendAudit({
      kind: "reject",
      id: updated.id,
      platform: updated.platform,
      rejectedBy: updated.rejectedBy,
      rejectedAt: updated.rejectedAt,
      rejectReason: updated.rejectReason,
    });
  }
  return updated;
}

function getQueueStats() {
  const queue = readQueue();
  const pending = queue.filter((item) => item.status === "pending");
  const approved = queue.filter((item) => item.status === "approved");
  const rejected = queue.filter((item) => item.status === "rejected");
  return {
    total: queue.length,
    pending: pending.length,
    approved: approved.length,
    rejected: rejected.length,
  };
}

module.exports = {
  enqueueModeration,
  listQueue,
  getQueueItem,
  editQueueItem,
  regenerateQueueItem,
  approveQueueItem,
  rejectQueueItem,
  getQueueStats,
};
