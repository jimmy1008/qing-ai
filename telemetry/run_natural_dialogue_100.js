"use strict";

const fs = require("fs");
const path = require("path");
const { processEvent } = require("../ai/orchestrator");

const prompts = [
  "你好", "今天有點累", "剛剛吃完飯", "我有點想睡", "今天心情還行", "剛剛看到一個很好笑的東西", "最近天氣怪怪的", "我在想晚點要不要出去走走", "剛剛有點分心", "其實我有點懶", "你會不會覺得今天很安靜", "我現在有點無聊", "剛剛突然想到以前的事情", "我想放空一下", "你平常會注意人心情嗎", "有時候我會想太多", "今天沒有發生什麼大事", "只是想隨便聊聊", "你覺得人為什麼會突然低潮", "我覺得晚上比較容易想東想西",
];

const projectRoot = process.cwd();
const logPath = path.join(projectRoot, "logs", "connector.log");
const statusPath = path.join(projectRoot, "telemetry", "natural_dialogue_100_status.json");

function writeLog(stage, data = {}) {
  const entry = { timestamp: new Date().toISOString(), stage, ...data };
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function writeStatus(data) {
  fs.writeFileSync(statusPath, JSON.stringify({ timestamp: new Date().toISOString(), ...data }, null, 2));
}

(async () => {
  writeStatus({ state: "running", completedRounds: 0, targetRounds: 100 });

  for (let i = 0; i < 100; i += 1) {
    const text = prompts[i % prompts.length];
    const event = {
      type: "message",
      content: text,
      text,
      userId: "sim_user_1001",
      fromId: "sim_user_1001",
      username: "sim_natural_user",
      connector: "telegram",
      platform: "telegram",
      isPrivate: true,
      channel: "private",
      mentionDetected: false,
      isDirectMention: false,
      isCommand: false,
      chat: { id: "sim_chat_1001", type: "private" },
      chatId: "sim_chat_1001",
      meta: { isDeveloper: false },
    };

    writeLog("incoming", {
      text,
      chatId: "sim_chat_1001",
      chatType: "private",
      channel: "private",
      mentionDetected: false,
      isDirectMention: false,
      isCommand: false,
      isDeveloper: false,
      userId: "sim_user_1001",
      username: "sim_natural_user",
    });

    writeLog("pipeline_dispatch", {
      text,
      chatId: "sim_chat_1001",
      chatType: "private",
      channel: "private",
      isDirectMention: false,
      isDeveloper: false,
      userId: "sim_user_1001",
      username: "sim_natural_user",
    });

    const result = await processEvent(event);

    writeLog("reply", {
      text: result.reply,
      skipped: Boolean(result.skipped),
      halted: Boolean(result.halted),
      intent: result.meta?.intent || "none",
      routing_level: result.meta?.routing_level ?? null,
      judge_pass: result.meta?.judge_pass ?? null,
      judge_score: result.meta?.judge_score ?? null,
      repair_action: result.meta?.repair_action || "none",
      channel: "private",
      connector: "telegram",
      chatId: "sim_chat_1001",
      chatType: "private",
    });

    writeStatus({ state: "running", completedRounds: i + 1, targetRounds: 100 });
  }

  writeStatus({ state: "completed", completedRounds: 100, targetRounds: 100 });
})().catch((err) => {
  writeStatus({ state: "failed", error: err.message });
  fs.appendFileSync(
    path.join(projectRoot, "logs", "events.log"),
    `${JSON.stringify({ timestamp: new Date().toISOString(), stage: "natural_dialogue_batch_error", message: err.message })}\n`,
  );
  process.exit(1);
});
