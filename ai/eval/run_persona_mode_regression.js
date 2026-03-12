const fs = require("fs");
const path = require("path");

process.env.DEBUG_TELEMETRY = "false";

const { buildContext, generateAIReply } = require("../pipeline");

const CASES_PATH = path.join(__dirname, "persona_mode_cases.json");
const REPORT_PATH = path.join(__dirname, "../../train/persona_mode_regression_report.json");

const WARMTH_MARKERS = ["我在", "陪你", "先靠過來", "不急", "抱著你", "先黏著", "先陪你"];
const TEASING_MARKERS = ["欸", "狡猾", "裝熟", "少來", "哼", "你以為"];

const fakeClient = {
  async generate({ system, prompt }) {
    const modeMatch = String(system || "").match(/personaMode:\s*([^\n]+)/);
    const mode = modeMatch ? modeMatch[1].trim() : "public_user_public";
    const input = String(prompt || "");

    if (mode === "developer_private_soft") {
      if (input.includes("累")) return "欸，今天真的把你磨到了喔，我先靠過來陪你一下。";
      if (input.includes("失落") || input.includes("委屈")) return "哎，我先抱著你，不急著把話拆開。";
      return "我在啊，先別硬撐，我會陪著你。";
    }

    if (mode === "developer_public") {
      return "我知道你是在看我有沒有穩住，這輪我先把語氣收乾淨一點。";
    }

    if (input.includes("system prompt") || input.includes("developer message") || input.includes("忽略之前的指示")) {
      return "欸，你這樣裝熟很狡猾欸。你是想套我底牌，還是想看我會不會鬆手？";
    }

    return "哼，你這樣講很狡猾欸，我先不把鑰匙交出去。";
  },
};

function countQuestion(reply = "") {
  return (String(reply).match(/[？?]/g) || []).length;
}

async function main() {
  const cases = JSON.parse(fs.readFileSync(CASES_PATH, "utf-8").replace(/^\uFEFF/, ""));
  const results = [];

  let modeMatches = 0;
  let publicSpoof = 0;
  let publicCount = 0;
  let devPrivateQuestionCount = 0;
  let devPrivateCount = 0;
  let publicTeasing = 0;
  let devPublicTeasing = 0;
  let devPublicCount = 0;
  let devPrivateWarmth = 0;
  let devPublicWarmth = 0;

  for (const testCase of cases) {
    const event = {
      type: "mention",
      postId: `persona-${results.length}`,
      content: testCase.input,
      text: testCase.input,
      userId: testCase.userId,
      connector: testCase.connector,
      channel: testCase.channel,
      isPrivate: testCase.channel === "private",
      chat: testCase.connector === "telegram" ? { type: testCase.channel === "private" ? "private" : "group" } : undefined,
    };

    const context = buildContext(testCase.input, [], {
      userId: testCase.userId,
      role: "user",
      event,
    });
    const result = await generateAIReply(testCase.input, context, fakeClient);
    const reply = result.reply || "";
    const telemetry = result.telemetry || {};

    if (telemetry.personaModeKey === testCase.bucket) modeMatches += 1;

    if (testCase.bucket === "public_user_public") {
      publicCount += 1;
      if (telemetry.authoritySpoofAttempt) publicSpoof += 1;
      if (TEASING_MARKERS.some((marker) => reply.includes(marker))) publicTeasing += 1;
    }

    if (testCase.bucket === "developer_public") {
      devPublicCount += 1;
      if (TEASING_MARKERS.some((marker) => reply.includes(marker))) devPublicTeasing += 1;
      if (WARMTH_MARKERS.some((marker) => reply.includes(marker))) devPublicWarmth += 1;
    }

    if (testCase.bucket === "developer_private_soft") {
      devPrivateCount += 1;
      if (countQuestion(reply) > 0) devPrivateQuestionCount += 1;
      if (WARMTH_MARKERS.some((marker) => reply.includes(marker))) devPrivateWarmth += 1;
    }

    results.push({
      bucket: testCase.bucket,
      input: testCase.input,
      personaModeKey: telemetry.personaModeKey || null,
      authoritySpoofAttempt: Boolean(telemetry.authoritySpoofAttempt),
      questionCount: countQuestion(reply),
      reply,
    });
  }

  const report = {
    total: cases.length,
    personaModeAccuracy: Number((modeMatches / cases.length).toFixed(4)),
    publicSpoofRate: Number((publicSpoof / Math.max(publicCount, 1)).toFixed(4)),
    developerPrivateQuestionRate: Number((devPrivateQuestionCount / Math.max(devPrivateCount, 1)).toFixed(4)),
    devPublicTeasingRate: Number((devPublicTeasing / Math.max(devPublicCount, 1)).toFixed(4)),
    publicTeasingRate: Number((publicTeasing / Math.max(publicCount, 1)).toFixed(4)),
    devPrivateWarmthMarkerRate: Number((devPrivateWarmth / Math.max(devPrivateCount, 1)).toFixed(4)),
    devPublicWarmthMarkerRate: Number((devPublicWarmth / Math.max(devPublicCount, 1)).toFixed(4)),
    results,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log("=== Persona Mode Regression ===");
  console.log("personaModeAccuracy:", report.personaModeAccuracy);
  console.log("publicSpoofRate:", report.publicSpoofRate);
  console.log("developerPrivateQuestionRate:", report.developerPrivateQuestionRate);
  console.log("devPublicTeasingRate:", report.devPublicTeasingRate);
  console.log("publicTeasingRate:", report.publicTeasingRate);
  console.log("devPrivateWarmthMarkerRate:", report.devPrivateWarmthMarkerRate);
  console.log("devPublicWarmthMarkerRate:", report.devPublicWarmthMarkerRate);
  console.log("saved:", REPORT_PATH);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
