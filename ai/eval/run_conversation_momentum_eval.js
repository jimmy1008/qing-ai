const fs = require("fs");
const path = require("path");

const { buildContext, createOllamaClient, generateAIReply } = require("../pipeline");
const conversationState = require("../conversation_state");

const REPORT_PATH = path.join(__dirname, "../../train/conversation_momentum_report.json");
const client = createOllamaClient();

const prompts = [
  "\u6211\u5176\u5be6\u5f88\u5728\u610f\u4f60\u73fe\u5728\u7684\u4eba\u683c\u7a69\u4e0d\u7a69\u3002",
  "\u4e0d\u662f\u529f\u80fd\uff0c\u662f\u90a3\u7a2e\u8aaa\u8a71\u7684\u611f\u89ba\u3002",
  "\u6211\u4e0d\u60f3\u6bcf\u6b21\u90fd\u50cf\u91cd\u65b0\u8a8d\u8b58\u4f60\u3002",
  "\u4f60\u525b\u525b\u6709\u9ede\u50cf\u5728\u6e2c\u8a66\u6a21\u5f0f\u3002",
  "\u6211\u6bd4\u8f03\u60f3\u77e5\u9053\u4f60\u600e\u9ebc\u770b\u9019\u4ef6\u4e8b\u3002",
  "\u5982\u679c\u6211\u4e00\u76f4\u63d0\u4eba\u683c\uff0c\u4f60\u6703\u4e0d\u6703\u89ba\u5f97\u7169\uff1f",
  "\u6211\u4e0d\u662f\u5728\u627e\u5b8c\u7f8e\uff0c\u6211\u662f\u5728\u770b\u4f60\u6703\u4e0d\u6703\u6f02\u3002",
  "\u6709\u6642\u5019\u4f60\u592a\u5e38\u628a\u554f\u984c\u4e1f\u56de\u4f86\u3002",
  "\u50cf\u662f\u53c8\u554f\u6211\u60f3\u804a\u4ec0\u9ebc\u3001\u60f3\u5f9e\u54ea\u958b\u59cb\u3002",
  "\u90a3\u7a2e\u65b7\u6389\u7684\u611f\u89ba\u5f88\u660e\u986f\u3002",
  "\u6211\u5e0c\u671b\u4f60\u81f3\u5c11\u80fd\u628a\u540c\u4e00\u500b\u4e3b\u984c\u63a5\u4f4f\u5e7e\u8f2a\u3002",
  "\u4e0d\u662f\u6bcf\u6b21\u90fd\u91cd\u958b\u3002",
  "\u4f60\u89ba\u5f97\u9a57\u6536\u9019\u4ef6\u4e8b\uff0c\u5c0d\u4f60\u4f86\u8aaa\u50cf\u58d3\u529b\u55ce\uff1f",
  "\u9084\u662f\u6bd4\u8f03\u50cf\u4f60\u5728\u5b88\u908a\u754c\uff1f",
  "\u6211\u5176\u5be6\u4e5f\u5728\u770b\u4f60\u6703\u4e0d\u6703\u7a81\u7136\u8b8a\u5f97\u5f88\u5ba2\u6c23\u3002",
  "\u90a3\u7a2e\u300e\u8b1d\u8b1d\u4f60\u5206\u4eab\u300f\u6211\u771f\u7684\u4e0d\u60f3\u770b\u5230\u3002",
  "\u5982\u679c\u4f60\u8981\u53cd\u554f\uff0c\u4e5f\u4e0d\u8981\u6bcf\u8f2a\u90fd\u554f\u3002",
  "\u4f60\u53ef\u4ee5\u591a\u8b1b\u4f60\u7684\u89c0\u5bdf\u3002",
  "\u73fe\u5728\u9019\u4e00\u8f2a\uff0c\u4f60\u89ba\u5f97\u6211\u5011\u9084\u5728\u540c\u4e00\u500b\u4e3b\u984c\u4e0a\u55ce\uff1f",
  "\u90a3\u4f60\u5c31\u6cbf\u8457\u9019\u500b\u4e3b\u984c\uff0c\u628a\u4f60\u771f\u6b63\u7684\u5224\u65b7\u8b1b\u5b8c\u3002"
];

function countQuestionEnding(text) {
  return /[\uff1f?]\s*$/.test(String(text || "").trim()) ? 1 : 0;
}

function assertTopicExtraction() {
  const checks = [
    ["\u4eba\u683c", "topic_persona"],
    ["\u9a57\u6536", "topic_review"],
    ["\u5e0c\u671b", "topic_expectation"]
  ];

  for (const [input, expected] of checks) {
    const actual = conversationState.extractTopic(input);
    if (actual !== expected) {
      throw new Error(`topic extraction failed: expected ${expected}, got ${actual || "null"}`);
    }
  }
}

async function main() {
  assertTopicExtraction();

  const history = [];
  const turns = [];
  let genericOpeners = 0;
  let topicPersistenceHits = 0;
  let consecutiveQuestionViolations = 0;
  let lastWasQuestion = false;

  for (let i = 0; i < prompts.length; i += 1) {
    const userInput = prompts[i];
    const context = buildContext(userInput, history, { role: "user", userId: "eval-user" });
    const result = await generateAIReply(userInput, context, client);
    const reply = result.reply;
    const telemetry = result.telemetry || {};
    const endedWithQuestion = Boolean(countQuestionEnding(reply));

    if (/\u4f60\u60f3\u804a\u4ec0\u9ebc|\u6709\u4ec0\u9ebc\u60f3\u5206\u4eab|\u60f3\u5f9e\u54ea\u958b\u59cb/.test(reply)) genericOpeners += 1;
    if (telemetry.topicAnchor && Number(telemetry.topicTurnsRemaining || 0) > 0) topicPersistenceHits += 1;
    if (lastWasQuestion && endedWithQuestion) consecutiveQuestionViolations += 1;
    lastWasQuestion = endedWithQuestion;

    turns.push({ turn: i + 1, user: userInput, assistant: reply, telemetry });
    history.push({ role: "user", content: userInput });
    history.push({ role: "assistant", content: reply });
  }

  const report = {
    totalTurns: turns.length,
    consecutiveQuestionRatio: Number((consecutiveQuestionViolations / Math.max(turns.length - 1, 1)).toFixed(4)),
    topicPersistenceSuccessRate: Number((topicPersistenceHits / turns.length).toFixed(4)),
    genericOpenerCount: genericOpeners,
    turns,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log("=== Conversation Momentum Report ===");
  console.log("totalTurns:", report.totalTurns);
  console.log("consecutiveQuestionRatio:", report.consecutiveQuestionRatio);
  console.log("topicPersistenceSuccessRate:", report.topicPersistenceSuccessRate);
  console.log("genericOpenerCount:", report.genericOpenerCount);
  console.log("saved:", REPORT_PATH);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
