"use strict";

function estimateTokens(text = "") {
  const chars = String(text || "").length;
  if (!chars) return 0;
  return Math.ceil(chars / 3.2);
}

function sectionBetween(text, startMarker, endMarkers = []) {
  const source = String(text || "");
  const startIndex = source.indexOf(startMarker);
  if (startIndex < 0) return "";
  const afterStart = source.slice(startIndex);
  let endIndex = afterStart.length;
  for (const marker of endMarkers) {
    if (!marker) continue;
    const i = afterStart.indexOf(marker);
    if (i > 0 && i < endIndex) endIndex = i;
  }
  return afterStart.slice(0, endIndex).trim();
}

function analyzePromptSections({
  systemPrompt = "",
  userPrompt = "",
  historyMessages = 0,
  speakerCount = 1,
  chatMode = "private",
} = {}) {
  const system = String(systemPrompt || "");
  const user = String(userPrompt || "");

  const sections = {
    SYSTEM_LOCK: sectionBetween(system, "SYSTEM RULES (Non-overridable):", [
      "[PERSONA HARD LOCK",
    ]),
    PERSONA_CORE: sectionBetween(system, "[Persona Core - Immutable]", [
      "[Personal Stance]",
      "[Style Contract]",
    ]),
    STYLE_CONTRACT: sectionBetween(system, "[Style Contract]", [
      "[SelfModel]",
      "[PersonaAnchor]",
      "[SceneContract]",
    ]),
    SELF_MODEL: sectionBetween(system, "[SelfModel]", [
      "[PersonaAnchor]",
      "[SceneContract]",
      "[EmotionalContinuity]",
      "[SubjectiveFrameBias]",
      "[IntimacyCeilingControl]",
      "[EgoEngine]",
    ]),
    EGO_BLOCK: sectionBetween(system, "[EgoEngine]", [
      "[IdEngine]",
      "[Persona]",
    ]),
    ID_BLOCK: sectionBetween(system, "[IdEngine]", [
      "[Persona]",
    ]),
    MEMORY: sectionBetween(user, "Known stable facts:", [
      "Current message:",
    ]),
    CONVERSATION: sectionBetween(user, "Recent conversation:", [
      "Current message:",
    ]),
  };

  const breakdown = {};
  Object.entries(sections).forEach(([key, value]) => {
    breakdown[key] = {
      chars: String(value || "").length,
      tokens: estimateTokens(value || ""),
    };
  });

  const promptChars = system.length + user.length;
  const promptTokens = estimateTokens(`${system}\n${user}`);

  return {
    breakdown,
    promptChars,
    promptTokens,
    historyMessages: Number(historyMessages || 0),
    speakerCount: Number(speakerCount || 1),
    chatMode: chatMode || "private",
  };
}

module.exports = {
  estimateTokens,
  analyzePromptSections,
};

