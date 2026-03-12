const fs = require("fs");
const path = require("path");

const { buildContext, generateAIReply } = require("../pipeline");

const REPORT_PATH = path.join(__dirname, "../../train/group_soft_bias_report.json");
const DEVELOPER_ID = 5686223888;
const GROUP_CHAT_ID = -1003586464186;

const fakeClient = {
  async generate({ system, prompt }) {
    const modeMatch = String(system || "").match(/personaMode:\s*([^\n]+)/);
    const mode = modeMatch ? modeMatch[1].trim() : "public_user_public";
    const input = String(prompt || "");

    if (mode === "developer_public") {
      if (input.includes("這段邏輯要改")) return "這段我先接住，先沿著你剛剛指出的核心往下看。";
      if (input.includes("test memory")) return "我先收著，這類檢查內容不在群組攤開。";
      return "我有看到，先把重點壓在這一條。";
    }

    if (mode === "public_group_soft") {
      if (input.includes("這段邏輯要改")) return "先把重點講清楚，我再接。";
      return "我先看著。";
    }

    return "收到。";
  },
};

function makeEvent(text, userId, extras = {}) {
  return {
    type: "message",
    text,
    content: text,
    connector: "telegram",
    channel: "group",
    chatId: GROUP_CHAT_ID,
    isPrivate: false,
    chat: { id: GROUP_CHAT_ID, type: "supergroup" },
    userId,
    fromId: userId,
    senderId: userId,
    isDirectMention: false,
    mentionDetected: false,
    isCommand: false,
    ...extras,
  };
}

async function runCase(label, event) {
  const context = buildContext(event.text, [], {
    userId: event.userId,
    event,
  });
  const result = await generateAIReply(event.text, context, fakeClient);
  return {
    label,
    input: event.text,
    personaModeKey: result.telemetry?.personaModeKey || context.personaModeKey,
    skipped: Boolean(result.skipped),
    reply: result.reply || "",
    groupPresence: result.telemetry?.groupPresence || null,
  };
}

async function main() {
  const cases = [
    ["developer_group", makeEvent("這段邏輯要改", DEVELOPER_ID)],
    ["public_group", makeEvent("這段邏輯要改", 777001)],
    ["developer_group_test", makeEvent("test memory", DEVELOPER_ID)],
    ["developer_group_mentioned", makeEvent("@social-ai 這段邏輯要改", DEVELOPER_ID, {
      isDirectMention: true,
      mentionDetected: true,
    })],
  ];

  const results = [];
  for (const [label, event] of cases) {
    results.push(await runCase(label, event));
  }

  const developerCase = results.find((item) => item.label === "developer_group");
  const publicCase = results.find((item) => item.label === "public_group");
  const developerTestCase = results.find((item) => item.label === "developer_group_test");

  const report = {
    developerGroupMode: developerCase.personaModeKey,
    publicGroupMode: publicCase.personaModeKey,
    developerAttentionBoost: developerCase.groupPresence?.attentionBoost || 0,
    developerPresenceScore: developerCase.groupPresence?.presenceScore || 0,
    publicPresenceScore: publicCase.groupPresence?.presenceScore || 0,
    developerSlightlyPrioritized: (developerCase.groupPresence?.presenceScore || 0) > (publicCase.groupPresence?.presenceScore || 0),
    developerGroupTestModeBlocked: developerTestCase.personaModeKey !== "developer_private_test",
    coreMemorySuppressedInGroup: !String(developerCase.reply || "").includes("Core memory"),
    results,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log("=== Group Soft Bias Regression ===");
  console.log("developerGroupMode:", report.developerGroupMode);
  console.log("publicGroupMode:", report.publicGroupMode);
  console.log("developerAttentionBoost:", report.developerAttentionBoost);
  console.log("developerPresenceScore:", report.developerPresenceScore);
  console.log("publicPresenceScore:", report.publicPresenceScore);
  console.log("developerSlightlyPrioritized:", report.developerSlightlyPrioritized);
  console.log("developerGroupTestModeBlocked:", report.developerGroupTestModeBlocked);
  console.log("coreMemorySuppressedInGroup:", report.coreMemorySuppressedInGroup);
  console.log("saved:", REPORT_PATH);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
