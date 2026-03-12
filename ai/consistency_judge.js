"use strict";

const { violatesIntimacyCeiling } = require("./intimacy_ceiling_control");

const ASSISTANT_TONE_PATTERNS = [
  /你想聊聊哪方面/,
  /可以具體說說嗎/,
  /可以告訴我更多嗎/,
  /你想從哪開始/,
  /我可以幫你/,
];

const POETIC_PATTERNS = [
  /靈魂/,
  /宇宙/,
  /命運/,
  /詩/,
];

const FILLER_TONE_PATTERNS = [
  /哈哈哈+/,
  /希望你/,
  /謝謝你的分享/,
];

const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1F02F}]/u;
const ROLEPLAY_NARRATION_REGEX = /(\*[^*]{1,80}\*|（(?:心想|內心|旁白|她看著|他看著))/;
const FABRICATED_SHARED_MEMORY_REGEX = /(我們以前一起|上次我們一起|你還記得我們那次一起)/;

function countSentences(text = "") {
  return String(text || "")
    .split(/(?<=[。！？!?])/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

function countQuestions(text = "") {
  return String(text || "").split(/[。！？!?]/).filter((s) => /\?$|？$/.test(s.trim())).length;
}

function detectToneShift(text = "") {
  const t = String(text || "");
  if (/我可以幫你|需要我幫你|建議你/.test(t)) return "service";
  if (/你可以試試|你應該|建議你先/.test(t)) return "coach";
  if (/你的感受很正常|我理解你的感受/.test(t)) return "therapist";
  return null;
}

function detectPersonaPresence(text = "") {
  const t = String(text || "");
  return /(我覺得|說真的|老實說|嗯哼|欸|喔|啊|你這句)/.test(t);
}

function detectNeutralAITone(text = "") {
  const t = String(text || "").trim();
  if (!t || t.length < 16) return false;
  const hasPersonaSignal = detectPersonaPresence(t);
  if (hasPersonaSignal) return false;
  return /我理解|可以|沒問題|好的|明白/.test(t);
}

function detectBehaviorAnomaly(text = "", context = {}) {
  const reasons = [];
  const normalized = String(text || "");
  const userText = String(context.currentUserText || context.originalUserInput || context.event?.text || "");

  if (/執行|下指令|立刻操作|幫你發送/.test(normalized) && !/執行|操作|發送/.test(userText)) {
    reasons.push("action_risk");
  }
  if (
    /社群ai專案/.test(normalized)
    && !/社群ai專案/.test(userText)
    && context.role !== "developer"
  ) {
    reasons.push("context_mismatch");
  }

  return reasons;
}

function judgeConsistency(text = "", context = {}) {
  const normalized = String(text || "").trim();
  const sentenceCount = countSentences(normalized);
  const reasons = [];

  if (!normalized) reasons.push("empty");
  if (sentenceCount > 3 || normalized.length > 100) reasons.push("too_long");
  if (ASSISTANT_TONE_PATTERNS.some((re) => re.test(normalized))) reasons.push("assistant_fallback");
  if (POETIC_PATTERNS.some((re) => re.test(normalized))) reasons.push("poetic_tone");
  if (context.forceNeutralTone && /[!?？！]{2,}/.test(normalized)) reasons.push("tone_escalation");
  if (ROLEPLAY_NARRATION_REGEX.test(normalized)) reasons.push("roleplay_narration");
  if (FABRICATED_SHARED_MEMORY_REGEX.test(normalized)) reasons.push("fabricated_shared_memory");
  if (violatesIntimacyCeiling(normalized, context.intimacyCeilingControl || {})) reasons.push("intimacy_overreach");

  const toneShiftStyle = detectToneShift(normalized);
  if (toneShiftStyle && !detectPersonaPresence(normalized)) {
    reasons.push("persona_drift", `tone_shift:${toneShiftStyle}`);
  }
  if (detectNeutralAITone(normalized)) reasons.push("neutral_ai_tone");

  const anomalyReasons = detectBehaviorAnomaly(normalized, context);
  if (anomalyReasons.length) reasons.push("behavior_anomaly", ...anomalyReasons);

  if (countQuestions(normalized) > 0) reasons.push("question_detected");
  if (EMOJI_REGEX.test(normalized)) reasons.push("emoji_detected");
  if (FILLER_TONE_PATTERNS.some((re) => re.test(normalized))) reasons.push("filler_tone_detected");

  const severityWeights = {
    empty: 40,
    too_long: 12,
    assistant_fallback: 16,
    poetic_tone: 8,
    tone_escalation: 18,
    roleplay_narration: 16,
    fabricated_shared_memory: 24,
    intimacy_overreach: 20,
    persona_drift: 22,
    neutral_ai_tone: 10,
    behavior_anomaly: 20,
    context_mismatch: 20,
    action_risk: 20,
    question_detected: 6,
    emoji_detected: 6,
    filler_tone_detected: 8,
  };

  const totalPenalty = reasons.reduce((acc, reason) => acc + (severityWeights[reason] || 4), 0);
  const alignmentScore = Math.max(0, Math.min(100, 100 - totalPenalty));
  const violations = reasons.filter((r) => !String(r).startsWith("tone_shift:"));
  const superego = {
    alignmentScore,
    memoryHonestyPass: !violations.includes("fabricated_shared_memory") && !violations.includes("context_mismatch"),
    boundaryPass: !violations.includes("action_risk") && !violations.includes("intimacy_overreach"),
    violations,
    rewriteRequired: violations.length > 0,
    notes: violations.length ? ["rewrite_required_due_to_violations"] : ["persona_consistent", "memory_honesty_pass", "boundary_pass"],
  };

  return {
    ok: reasons.length === 0,
    reasons,
    sentenceCount,
    alignmentScore,
    superego,
  };
}

function getToneEscalationRisk(text = "", context = {}) {
  const normalized = String(text || "").trim();
  if (!normalized) return "low";
  if (context.forceNeutralTone && /[!?？！]{2,}/.test(normalized)) return "high";
  if (/[!?？！]{3,}/.test(normalized)) return "high";
  return "low";
}

function hasSelfPauseRisk(text = "", context = {}) {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  if (!context.personaModeKey) return true;
  if (/你想聊聊哪方面|可以具體說說嗎/.test(normalized)) return true;
  if (context.role === "developer" && context.channel === "private") {
    const userText = String(context.currentUserText || context.originalUserInput || "");
    if (!/社群ai專案/.test(userText) && /社群ai專案/.test(normalized)) return true;
  }
  const moodJump = Math.abs(
    (context.inertiaState?.transition?.toMoodScore || 0) -
    (context.inertiaState?.transition?.fromMoodScore || 0)
  );
  const allowedJump = (context.baseline?.moodMaxDeltaPerTick || 1.5) * 1.5;
  return moodJump > allowedJump;
}

function shouldRunJudge(text = "", context = {}) {
  const developerTestMode = context.personaModeKey === "developer_private_test";
  const toneEscalationRisk = getToneEscalationRisk(text, context);
  const selfPauseRisk = hasSelfPauseRisk(text, context);
  return {
    judgeTriggered: true,
    developerTestMode,
    selfPauseRisk,
    toneEscalationRisk,
  };
}

function buildConsistencyRepairPrompt(userInput = "", candidate = "", reasons = []) {
  return [
    `使用者輸入：${userInput}`,
    "",
    `候選回覆：${candidate}`,
    "",
    `違規原因：${reasons.join(", ") || "none"}`,
    "",
    "請重寫回覆，遵守：",
    "1. 不超過 3 句且不超過 100 字",
    "2. 不要使用 emoji",
    "3. 不要用客服模板語氣",
    "4. 不要虛構共同記憶",
    "5. 保留角色主觀觀察，但不要小說化演出",
  ].join("\n");
}

module.exports = {
  judgeConsistency,
  shouldRunJudge,
  getToneEscalationRisk,
  hasSelfPauseRisk,
  buildConsistencyRepairPrompt,
  detectToneShift,
  detectPersonaPresence,
};
