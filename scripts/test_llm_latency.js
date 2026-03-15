"use strict";

const { createMultiModelClient, MAIN_MODEL, FAST_MODEL } = require("../ai/llm_client");
const { analyzePromptSections, estimateTokens } = require("../ai/debug/prompt_analysis");

function nowMs() {
  return Date.now();
}

async function runCall(client, modelKind, system, prompt) {
  const start = nowMs();
  let text = "";
  let timeout = false;
  try {
    if (modelKind === "main") {
      text = await client.generate({ system, prompt });
    } else {
      text = await client.generateFast({ system, prompt });
    }
    timeout = !String(text || "").trim();
  } catch {
    timeout = true;
  }

  return {
    model: modelKind === "main" ? MAIN_MODEL : FAST_MODEL,
    latencyMs: nowMs() - start,
    timeout,
    outputChars: String(text || "").length,
  };
}

function printRows(rows) {
  console.log("\nTest\tModel\tLatency(ms)\tTimeout\tOutputChars");
  rows.forEach((r) => {
    console.log(`${r.test}\t${r.model}\t${r.latencyMs}\t${r.timeout}\t${r.outputChars}`);
  });
}

async function main() {
  const client = createMultiModelClient();
  const rows = [];

  const simple = {
    name: "simple_prompt",
    system: "You are concise.",
    prompt: "Say hi in Traditional Chinese, one short sentence.",
  };

  const medium = {
    name: "medium_prompt",
    system: [
      "You are a social assistant.",
      "Respond in Traditional Chinese.",
      "Keep it concise and natural.",
      "No bullet points.",
    ].join("\n"),
    prompt: "我今天有點累，但又睡不著，給我一句自然回覆。",
  };

  const fullSystem = [
    "Persona: warm but direct, no AI self-reference.",
    "Constraints:",
    "- Traditional Chinese",
    "- No emoji",
    "- 1-2 sentences",
    "- avoid generic filler",
    "Context:",
    "- user role: developer",
    "- channel: private",
    "- recent mood: tired",
  ].join("\n");

  const fullUserPrompt = [
    "Recent messages:",
    "user: 今天事情有點多",
    "assistant: 你先把最急的那件處理掉就好。",
    "user: 我剛剛又分心了",
    "",
    "Current message:",
    "我現在很想休息但還有事沒做完。",
  ].join("\n");

  const full = {
    name: "full_system_prompt",
    system: fullSystem,
    prompt: fullUserPrompt,
  };

  for (const tc of [simple, medium, full]) {
    const mainResult = await runCall(client, "main", tc.system, tc.prompt);
    rows.push({ test: tc.name, ...mainResult });

    const fastResult = await runCall(client, "fast", tc.system, tc.prompt);
    rows.push({ test: `${tc.name}_fast`, ...fastResult });
  }

  printRows(rows);

  const fullAnalysis = analyzePromptSections({
    systemPrompt: full.system,
    userPrompt: full.prompt,
    historyMessages: 3,
    speakerCount: 1,
    chatMode: "private",
  });

  console.log("\nPrompt Breakdown (full_system_prompt)");
  Object.entries(fullAnalysis.breakdown).forEach(([name, stats]) => {
    console.log(`${name}\tchars=${stats.chars}\ttokens=${stats.tokens}`);
  });
  console.log(`TOTAL\tchars=${fullAnalysis.promptChars}\ttokens=${fullAnalysis.promptTokens}`);
  console.log(`historyMessages=${fullAnalysis.historyMessages}\tspeakerCount=${fullAnalysis.speakerCount}\tchatMode=${fullAnalysis.chatMode}`);
  console.log(`quickEstimateTokens=${estimateTokens(`${full.system}\n${full.prompt}`)}`);
}

main().catch((err) => {
  console.error("[test_llm_latency] failed:", err?.message || err);
  process.exit(1);
});
