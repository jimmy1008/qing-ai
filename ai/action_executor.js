const fs = require("fs");
const path = require("path");
const { enqueueModeration } = require("./moderation_queue");

const logPath = path.join(__dirname, "../logs/actions.log");
fs.mkdirSync(path.dirname(logPath), { recursive: true });

function appendActionLog(entry) {
  fs.appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
}

function recordActionDecision(payload = {}) {
  appendActionLog({
    kind: "decision",
    intent: payload.intent || "none",
    engageDecision: payload.engageDecision || null,
    actionProposal: payload.actionProposal || null,
    riskDecision: payload.riskDecision || null,
    executionResult: payload.executionResult || null,
    event_type: payload.event?.type || null,
    user_id: payload.event?.userId || null,
    target: payload.event?.postId || null,
    role: payload.role || null,
    channel: payload.channel || null,
    connector: payload.connector || null,
    personaModeKey: payload.personaModeKey || null,
    authoritySpoofAttempt: Boolean(payload.authoritySpoofAttempt),
    replyText: payload.replyText || null,
  });
}

function executeAction(actionProposal, riskDecision, event = null) {
  if (!actionProposal) return null;

  if (actionProposal.platform === "threads") {
    const queued = enqueueModeration(actionProposal, event, riskDecision);
    const result = {
      executed: false,
      queued: true,
      moderation_id: queued.id,
      action: actionProposal.action,
      risk_level: actionProposal.risk_level,
      requires_approval: true,
      ts: new Date().toISOString(),
      reason: "queued_for_moderation",
    };

    appendActionLog({
      kind: "moderation_queue",
      queued: true,
      moderation_id: queued.id,
      action: actionProposal.action,
      risk_level: actionProposal.risk_level,
      target: actionProposal.target,
      event_type: event?.type || actionProposal.event_type || null,
      user_id: event?.userId || actionProposal.user_id || null,
      reason: result.reason,
      role: event?.role || null,
      channel: event?.channel || null,
      connector: event?.connector || null,
      personaModeKey: event?.personaModeKey || null,
    });

    return result;
  }

  const result = {
    executed: Boolean(riskDecision?.allowed),
    action: actionProposal.action,
    risk_level: actionProposal.risk_level,
    requires_approval: actionProposal.requires_approval,
    ts: new Date().toISOString(),
    reason: riskDecision?.reason || null,
  };

  appendActionLog({
    kind: "execution",
    executed: result.executed,
    action: result.action,
    risk_level: result.risk_level,
    requires_approval: result.requires_approval,
    target: actionProposal.target,
    event_type: event?.type || actionProposal.event_type || null,
    user_id: event?.userId || actionProposal.user_id || null,
    reason: result.reason,
    role: event?.role || null,
    channel: event?.channel || null,
    connector: event?.connector || null,
    personaModeKey: event?.personaModeKey || null,
  });

  return result;
}

module.exports = { executeAction, recordActionDecision };
