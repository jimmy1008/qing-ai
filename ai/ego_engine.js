"use strict";

const SCENE_CLAIM_RE = /(夢到|我們在|一起去|一起做|剛剛我們|那次我們)/;
const MEMORY_CLAIM_RE = /(我們之前|我記得|上次我們|你之前說過|你以前提過)/;

function hasQuestion(text = "") {
  return /[?？]/.test(String(text || ""));
}

function pickArchetype(userInput = "", idOutput = {}) {
  const text = String(userInput || "");
  const signals = Array.isArray(idOutput.signals) ? idOutput.signals : [];

  if (signals.includes("vulnerable")) return "acknowledge";
  if (signals.includes("challenging")) return "observation";
  if (signals.includes("playful")) return "tease";
  if (signals.includes("cold")) return "short_reply";
  if (hasQuestion(text)) return "question";
  return "observation";
}

function runSceneGate(userInput = "", context = {}) {
  const text = String(userInput || "");
  const triggered = SCENE_CLAIM_RE.test(text);

  let source = "none";
  if (triggered) source = "user_scene";

  const allowModelScene = source !== "none";
  return {
    triggered,
    source,
    allowModelScene,
    rule: "scene_must_come_from_user_or_memory",
  };
}

function runMemoryGate(userInput = "", context = {}) {
  const text = String(userInput || "");
  const triggered = MEMORY_CLAIM_RE.test(text);
  const knownFacts = context.identityMemory?.longTerm?.knownFacts || [];
  const hasEvidence = knownFacts.length > 0 || Boolean(context.conversationMemory?.summary);
  const allowSharedMemoryClaim = !triggered || hasEvidence;

  return {
    triggered,
    hasEvidence,
    allowSharedMemoryClaim,
    rule: "no_fabricated_shared_memory",
  };
}

function runIntimacyGate(context = {}, idOutput = {}) {
  const familiarity = Number(context.relationshipProfile?.familiarity || context.relationship?.familiarity || 0);
  const attachmentAffect = Number(idOutput?.affect?.attachment || 0);
  const channel = context.channel || "private";
  const role = context.role || "public_user";
  const semanticModes = Array.isArray(context.semanticModes) ? context.semanticModes : [];
  const claimSanitizer = context.claimSanitizer || {};
  const semanticChaos = semanticModes.some((m) => m === "role_confusion" || m === "relationship_probe" || m === "nonsense");

  const intimacyScore = Number((Math.min(1, familiarity / 100) * 0.7 + attachmentAffect * 0.3).toFixed(2));
  const threshold = channel === "group" || context.connector === "threads"
    ? 0.65
    : role === "developer"
      ? 0.8
      : 0.7;
  const blockedBySemantic =
    Boolean(semanticChaos)
    || Boolean(claimSanitizer.claimSanitized)
    || Boolean(claimSanitizer.forcedFamilyFraming)
    || Boolean(claimSanitizer.provocativeRelationshipLabel);
  const allowEscalation = !blockedBySemantic && intimacyScore >= threshold;

  return {
    intimacyScore,
    threshold,
    allowEscalation,
    blockedBySemantic,
    rule: "intimacy_must_follow_relationship_basis",
  };
}

function runEgoEngine({ userInput = "", context = {}, idOutput = {} } = {}) {
  const archetype = pickArchetype(userInput, idOutput);
  const sceneCheck = runSceneGate(userInput, context);
  const memoryCheck = runMemoryGate(userInput, context);
  const intimacyCheck = runIntimacyGate(context, idOutput);
  const semanticModes = Array.isArray(context.semanticModes) ? context.semanticModes : [];
  const semanticChaos = semanticModes.some((m) => m === "role_confusion" || m === "relationship_probe" || m === "nonsense");
  const claimSanitizer = context.claimSanitizer || {};
  const forceShortReply = Boolean(
    semanticChaos
    || claimSanitizer.absurdIdentityClaim
    || claimSanitizer.forcedFamilyFraming
    || claimSanitizer.provocativeRelationshipLabel
    || claimSanitizer.lowCoherenceTeasing
  );
  const replyLengthTarget = forceShortReply
    ? "semantic_short_guard"
    : (context.sceneContract?.replyMaxChars || 100) <= 60
      ? "concise_public"
      : "short_dialogue";
  const maxSentences = forceShortReply ? 2 : (replyLengthTarget === "concise_public" ? 2 : 3);
  const questionPolicy = forceShortReply
    ? "no_followup_question"
    : (context.sceneContract?.maxQuestions === 0 ? "no_followup_question" : "max_one_question");
  const observationPolicy = "at_least_one_subjective_observation";
  const intimacyCeiling = Number(context.sceneContract?.intimacyCeiling ?? 0.55);
  const sceneSourceTag = sceneCheck.source || "none";
  const relationshipFrame = "friend_playful";
  const semanticPolicy = {
    semanticMode: context.semanticMode || "normal_chat",
    semanticModes,
    enforceShortReply: forceShortReply,
    maxChars: forceShortReply ? 90 : Number(context.sceneContract?.replyMaxChars || 100),
    maxSentences,
    nonEscalating: forceShortReply,
    relationshipFrame,
  };

  return {
    archetype,
    tone: context.toneStyle || "casual",
    length: forceShortReply ? "short" : ((context.sceneContract?.replyMaxChars || 100) <= 60 ? "short" : "normal"),
    intimacy: intimacyCheck.intimacyScore,
    replyLengthTarget,
    maxSentences,
    questionPolicy,
    observationPolicy,
    intimacyCeiling,
    relationshipFrame,
    semanticPolicy,
    sceneSourceTag,
    sceneCheck,
    memoryCheck,
    intimacyCheck,
  };
}

function buildEgoBlock(ego) {
  if (!ego) return null;
  return [
    "[EgoEngine]",
    `- replyArchetype: ${ego.archetype}`,
    `- tone: ${ego.tone}`,
    `- length: ${ego.length}`,
    `- replyLengthTarget: ${ego.replyLengthTarget}`,
    `- maxSentences: ${ego.maxSentences}`,
    `- questionPolicy: ${ego.questionPolicy}`,
    `- observationPolicy: ${ego.observationPolicy}`,
    `- intimacyCeiling: ${ego.intimacyCeiling}`,
    `- relationshipFrame: ${ego.relationshipFrame || "friend_playful"}`,
    `- semanticMode: ${ego.semanticPolicy?.semanticMode || "normal_chat"}`,
    `- semanticShortReply: ${Boolean(ego.semanticPolicy?.enforceShortReply)}`,
    `- sceneSourceTag: ${ego.sceneSourceTag}`,
    `- intimacy: ${ego.intimacy}`,
    `- sceneGate: source=${ego.sceneCheck?.source}, allowModelScene=${ego.sceneCheck?.allowModelScene}`,
    `- memoryGate: allowSharedMemoryClaim=${ego.memoryCheck?.allowSharedMemoryClaim}, hasEvidence=${ego.memoryCheck?.hasEvidence}`,
    `- intimacyGate: allowEscalation=${ego.intimacyCheck?.allowEscalation}, blockedBySemantic=${ego.intimacyCheck?.blockedBySemantic}, score=${ego.intimacyCheck?.intimacyScore}, threshold=${ego.intimacyCheck?.threshold}`,
    "- Follow the selected replyArchetype and gate constraints. Do not invent shared scenes or memories.",
  ].join("\n");
}

module.exports = {
  runEgoEngine,
  buildEgoBlock,
};
