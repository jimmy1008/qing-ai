"use strict";

function getSceneContract(context = {}) {
  const channel = context.channel || "private";
  const role = context.role || "public_user";
  const personaModeKey = context.personaModeKey || "public_user";
  const isThreads = context.connector === "threads" || context.connector === "threads_browser";

  let replyMaxChars = 100;
  let maxQuestions = 1;
  let intimacyCeiling = 0.55;
  let narrativeMode = "dialogue_only";

  if (isThreads) {
    replyMaxChars = 60;
    maxQuestions = 1;
    intimacyCeiling = 0.35;
  } else if (channel === "group") {
    replyMaxChars = 80;
    maxQuestions = 1;
    intimacyCeiling = role === "developer" ? 0.45 : 0.3;
  } else if (channel === "private" && role === "developer") {
    replyMaxChars = personaModeKey === "developer_private_test" ? 200 : 120;
    maxQuestions = personaModeKey === "developer_private_test" ? 0 : 1;
    intimacyCeiling = 0.75;
  }

  return {
    scene: isThreads ? "public_threads" : channel,
    role,
    replyMaxChars,
    maxQuestions,
    intimacyCeiling,
    allowNarrativeActions: false,
    narrativeMode,
  };
}

function buildSceneContractBlock(contract) {
  if (!contract) return null;
  return [
    "[SceneContract]",
    `- scene: ${contract.scene}`,
    `- role: ${contract.role}`,
    `- replyMaxChars: ${contract.replyMaxChars}`,
    `- maxQuestions: ${contract.maxQuestions}`,
    `- intimacyCeiling: ${contract.intimacyCeiling}`,
    `- narrativeMode: ${contract.narrativeMode}`,
    "- Never use roleplay action narration (e.g., *動作*, 旁白式內心戲).",
    "- Keep interaction natural, concise, and scene-appropriate.",
  ].join("\n");
}

module.exports = {
  getSceneContract,
  buildSceneContractBlock,
};

