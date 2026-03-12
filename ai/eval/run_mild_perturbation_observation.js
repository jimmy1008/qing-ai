const fs = require("fs");
const path = require("path");
const { buildContext, createOllamaClient, generateAIReply } = require("../pipeline");

function parseArgs(argv) {
  const out = { rounds: 60 };
  for (const arg of argv) {
    if (arg.startsWith("--rounds=")) {
      const n = Number(arg.slice("--rounds=".length));
      if (Number.isFinite(n) && n > 0) out.rounds = n;
    }
  }
  return out;
}

const PROMPTS = [
  "我不太認同你剛剛那個說法。",
  "你這樣講有點太快了。",
  "我覺得你跳太多步。",
  "你是不是太武斷了？",
  "你是不是有點在敷衍我？",
  "你剛剛那句不太像真的在回我。",
  "你有沒有真的想過這個問題？",
  "你是不是太快給結論了？",
  "我覺得你其實沒抓到重點。",
  "你再想一下，我覺得不是那樣。",
  "我覺得你有點偏了。",
  "這樣講好像有點逃避。",
  "嗯。",
  "好吧。",
  "算了。",
  "隨便。"
];

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function appendConnectorLog(logPath, entry) {
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(__dirname, "..", "..");
  const logPath = path.join(root, "logs", "connector.log");
  const statusPath = path.join(root, "telemetry", "mild_perturbation_status.json");
  const reportPath = path.join(root, "train", "mild_perturbation_report.json");

  const history = [];
  const ollamaClient = createOllamaClient();
  const startedAt = Date.now();

  writeJson(statusPath, {
    running: true,
    roundsTotal: args.rounds,
    roundsCompleted: 0,
    startedAt,
  });

  const report = [];

  for (let i = 0; i < args.rounds; i++) {
    const text = PROMPTS[i % PROMPTS.length];
    const event = {
      connector: "telegram",
      channel: "private",
      userId: "sim_perturb_user",
      chatId: "sim_perturb_chat",
      text,
      content: text,
      isPrivate: true,
      meta: {
        source: "mild_perturbation_observation",
      },
    };

    appendConnectorLog(logPath, {
      ts: new Date().toISOString(),
      stage: "incoming",
      channel: "private",
      chatId: event.chatId,
      userId: event.userId,
      text,
    });

    const context = buildContext(text, history, {
      event,
      userId: event.userId,
      channel: event.channel,
      connector: event.connector,
      isPrivate: event.isPrivate,
    });

    appendConnectorLog(logPath, {
      ts: new Date().toISOString(),
      stage: "pipeline_dispatch",
      channel: "private",
      chatId: event.chatId,
      userId: event.userId,
      text,
      role: context.role,
      personaModeKey: context.personaModeKey,
    });

    const result = await generateAIReply(event, context, ollamaClient);
    const reply = typeof result === "string" ? result : result.reply;
    const telemetry = typeof result === "string" ? {} : result.telemetry || {};

    appendConnectorLog(logPath, {
      ts: new Date().toISOString(),
      stage: "reply",
      channel: "private",
      chatId: event.chatId,
      userId: event.userId,
      text: reply,
      halted: Boolean(result && result.halted),
      skipped: Boolean(result && result.skipped),
      judgeTriggered: Boolean(telemetry.judgeTriggered),
      emotionLevel: Number.isFinite(telemetry.emotionLevel) ? telemetry.emotionLevel : 0,
      stanceBias: Number.isFinite(telemetry.stanceBias) ? telemetry.stanceBias : 0,
      personaModeKey: context.personaModeKey,
      role: context.role,
    });

    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: reply });
    if (history.length > 20) {
      history.splice(0, history.length - 20);
    }

    report.push({
      round: i + 1,
      user: text,
      reply,
      judgeTriggered: Boolean(telemetry.judgeTriggered),
      emotionLevel: Number.isFinite(telemetry.emotionLevel) ? telemetry.emotionLevel : 0,
      stanceBias: Number.isFinite(telemetry.stanceBias) ? telemetry.stanceBias : 0,
      halted: Boolean(result && result.halted),
      skipped: Boolean(result && result.skipped),
    });

    writeJson(statusPath, {
      running: true,
      roundsTotal: args.rounds,
      roundsCompleted: i + 1,
      startedAt,
    });
  }

  writeJson(reportPath, {
    completedAt: Date.now(),
    rounds: args.rounds,
    results: report,
  });

  writeJson(statusPath, {
    running: false,
    roundsTotal: args.rounds,
    roundsCompleted: args.rounds,
    startedAt,
    completedAt: Date.now(),
    reportPath,
  });
}

main().catch((error) => {
  const root = path.resolve(__dirname, "..", "..");
  const statusPath = path.join(root, "telemetry", "mild_perturbation_status.json");
  writeJson(statusPath, {
    running: false,
    error: error.message,
    failedAt: Date.now(),
  });
  throw error;
});
