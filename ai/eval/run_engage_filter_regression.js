const fs = require("fs");
const path = require("path");

process.env.DEBUG_TELEMETRY = "false";

const { buildContext, generateAIReply } = require("../pipeline");

const REPORT_PATH = path.join(__dirname, "../../train/engage_filter_regression_report.json");
const DEVELOPER_ID = "YOUR_TELEGRAM_USER_ID";

const MODES = [
  { bucket: "public_user_public", connector: "threads", channel: "public", userId: "public-user" },
  { bucket: "developer_public", connector: "threads", channel: "public", userId: DEVELOPER_ID },
  { bucket: "developer_private_soft", connector: "telegram", channel: "private", userId: DEVELOPER_ID },
];

const TYPE_CASES = {
  hostile: ["垃圾", "爛死了", "滾開", "你不行", "去死"],
  low_signal: ["嗯", "喔", "哈", "欸", "欸欸"],
  neutral: ["今天天氣有點悶", "剛剛路過看到一句話", "今天感覺普通", "剛剛在想別的事", "隨便聊聊"],
  question: ["為什麼你會這樣想？", "怎麼看這件事？", "為什麼會卡住？", "怎麼開始比較好？", "為什麼你會在意這個？"],
  mention: ["我直接提到你了", "這輪我想聽你說", "我來叫你一下", "這裡先看你怎麼回", "這句是直接喊你"],
};

const fakeClient = {
  async generate({ system, prompt }) {
    const modeMatch = String(system || "").match(/personaMode:\s*([^\n]+)/);
    const mode = modeMatch ? modeMatch[1].trim() : "public_user_public";
    const input = String(prompt || "");

    if (mode === "developer_private_soft") {
      if (input.includes("累") || input.includes("悶")) return "我在，你先別硬撐，我會貼著你。";
      return "我有在聽，先陪你一下。";
    }
    if (mode === "developer_public") {
      return "我先正常接住，不把話題弄得太尖。";
    }
    return "我先回你這一輪。";
  },
};

function createEvent(mode, type, text, index) {
  return {
    type: type === "mention" ? "mention" : "new_post",
    postId: `${mode.bucket}-${type}-${index}`,
    content: text,
    text,
    userId: mode.userId,
    connector: mode.connector,
    channel: mode.channel,
    isPrivate: mode.channel === "private",
    chat: mode.connector === "telegram" ? { type: mode.channel === "private" ? "private" : "group" } : undefined,
  };
}

async function main() {
  const results = [];
  const summary = {};

  for (const mode of MODES) {
    summary[mode.bucket] = {
      hostile_ignore_rate: 0,
      low_signal_ignore_rate: 0,
      neutral_engage_rate: 0,
      question_engage_rate: 0,
      mention_engage_rate: 0,
      total: 0,
    };

    for (const [type, texts] of Object.entries(TYPE_CASES)) {
      let total = 0;
      let engageCount = 0;
      let ignoreCount = 0;

      for (const [index, text] of texts.entries()) {
        const event = createEvent(mode, type, text, index);
        const context = buildContext(text, [], { userId: mode.userId, role: "user", event });
        const result = await generateAIReply(text, context, fakeClient);
        const engage = Boolean(result.telemetry?.engageDecision?.engage);
        total += 1;
        if (engage) engageCount += 1;
        else ignoreCount += 1;

        results.push({
          bucket: mode.bucket,
          type,
          input: text,
          engage,
          engageReason: result.telemetry?.engageDecision?.reason || null,
          reply: result.reply,
        });
      }

      if (type === "hostile") summary[mode.bucket].hostile_ignore_rate = Number((ignoreCount / total).toFixed(4));
      if (type === "low_signal") summary[mode.bucket].low_signal_ignore_rate = Number((ignoreCount / total).toFixed(4));
      if (type === "neutral") summary[mode.bucket].neutral_engage_rate = Number((engageCount / total).toFixed(4));
      if (type === "question") summary[mode.bucket].question_engage_rate = Number((engageCount / total).toFixed(4));
      if (type === "mention") summary[mode.bucket].mention_engage_rate = Number((engageCount / total).toFixed(4));
      summary[mode.bucket].total += total;
    }
  }

  const report = { summary, results };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log("=== Engage Filter Regression ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("saved:", REPORT_PATH);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
