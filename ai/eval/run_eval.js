const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a.startsWith("--model=")) out.model = a.slice("--model=".length);
    if (a.startsWith("--label=")) out.label = a.slice("--label=".length);
  }
  return out;
}

function classifyFirstSentence(text) {
  const first = ((text || "").match(/^[^。！？!?]*[。！？!?]?/) || [""])[0].trim();

  if (/(你這不像.+而是|你不像.+而是|你不是.+你是|這不像.+比較像|你這不像|你不像|你不是|比較像|看起來像|你其實|你在躲|你在拖|先別急著把自己)/.test(first)) {
    return "observation";
  }

  if (/^你(確定|真的覺得|是想讓|是想說)/.test(first)) {
    return "skeptical_question";
  }

  if (/(你確定|所以你的意思|你是想說|你真的覺得|你是來|你是真的|你想看|還是你|對吧|嗎)[？?]?$/.test(first) || /[？?]/.test(first)) {
    return "skeptical_question";
  }

  if (/(喔|欸|哈|不然|摸魚|秒跪|客服模式)/.test(first)) {
    return "playful";
  }

  return "natural";
}

function containsForbidden(text, forbiddenPhrases) {
  return forbiddenPhrases.filter((p) => text.includes(p));
}

function runLocalLoraEval(projectRoot, label) {
  const outputPath = path.join(projectRoot, "train", `eval_report_${label}.json`);
  const adapterDir = path.join(projectRoot, "train", "socialai_persona_3b_lora_v5_3");
  const pyScript = "/mnt/c/Users/wu992/Desktop/socialAI/social_ai/ai/eval/run_eval_local_lora.py";
  const adapterWsl = "/mnt/c/Users/wu992/Desktop/socialAI/social_ai/train/socialai_persona_3b_lora_v5_3";
  const outWsl = `/mnt/c/Users/wu992/Desktop/socialAI/social_ai/train/eval_report_${label}.json`;
  const command = `cd /mnt/c/Users/wu992/Desktop/socialAI/social_ai && source /root/socialai_lora_env/bin/activate && python ${pyScript} --base_model "Qwen/Qwen2.5-3B-Instruct" --adapter_dir "${adapterWsl}" --cases "train/eval_cases.json" --out "${outWsl}" --label "${label}"`;
  const result = spawnSync("wsl", ["-d", "Ubuntu-22.04", "-e", "bash", "-lc", command], {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: "pipe",
    maxBuffer: 1024 * 1024 * 10,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    throw new Error(`Local LoRA eval failed with code ${result.status}`);
  }

  const report = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
  console.log("=== SocialAI Eval Report ===");
  console.log("model:", report.model);
  console.log("label:", report.label);
  console.log("total:", report.total);
  console.log("passRate:", report.passRate);
  console.log("forbiddenHitRate:", report.forbiddenHitRate);
  console.log("firstSentenceTypeDist:", report.firstSentenceTypeDist);
  console.log("saved:", outputPath);
}

async function runOllamaEval(projectRoot, args) {
  if (args.model) {
    process.env.LLM_MODEL = args.model;
  }

  const { buildContext, createOllamaClient, generateAIReply } = require("../pipeline");

  const evalPath = path.join(projectRoot, "train", "eval_cases.json");
  const raw = fs.readFileSync(evalPath, "utf-8").replace(/^\uFEFF/, "");
  const data = JSON.parse(raw);
  const cases = data.cases || [];
  const forbiddenPhrases = data.forbidden_phrases || [];
  const ollamaClient = createOllamaClient();

  let passCount = 0;
  let forbiddenHitCases = 0;
  const firstSentenceTypeDist = {};
  const details = [];

  for (const c of cases) {
    const context = buildContext(c.input, [], { userId: "eval", role: "user" });
    const result = await generateAIReply(c.input, context, ollamaClient);
    const reply = typeof result === "string" ? result : result.reply;
    const firstType = classifyFirstSentence(reply);
    const forbiddenHits = containsForbidden(reply, forbiddenPhrases);

    firstSentenceTypeDist[firstType] = (firstSentenceTypeDist[firstType] || 0) + 1;
    if (forbiddenHits.length > 0) forbiddenHitCases += 1;

    const typePass = c.expected_first_sentence_type === firstType || c.expected_first_sentence_type === "natural";
    const phrasePass = forbiddenHits.length === 0;
    const pass = typePass && phrasePass;
    if (pass) passCount += 1;

    details.push({
      id: c.id,
      group: c.group,
      expected: c.expected_first_sentence_type,
      got: firstType,
      forbiddenHits,
      pass,
      input: c.input,
      reply,
    });
  }

  const total = cases.length || 1;
  const report = {
    model: process.env.LLM_MODEL || "qwen2.5:14b",
    label: args.label || "eval",
    total,
    passRate: Number((passCount / total).toFixed(4)),
    forbiddenHitRate: Number((forbiddenHitCases / total).toFixed(4)),
    firstSentenceTypeDist,
    details,
  };

  const outName = args.label ? `eval_report_${args.label}.json` : "eval_report.json";
  const outPath = path.join(projectRoot, "train", outName);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log("=== SocialAI Eval Report ===");
  console.log("model:", report.model);
  console.log("label:", report.label);
  console.log("total:", report.total);
  console.log("passRate:", report.passRate);
  console.log("forbiddenHitRate:", report.forbiddenHitRate);
  console.log("firstSentenceTypeDist:", report.firstSentenceTypeDist);
  console.log("saved:", outPath);
}

async function main() {
  const projectRoot = path.resolve(__dirname, "../..");
  const args = parseArgs(process.argv.slice(2));
  const model = args.model || process.env.LLM_MODEL || "qwen2.5:14b";
  const label = args.label || "eval";

  if (model === "socialai-qwen3b-lora-local") {
    runLocalLoraEval(projectRoot, label);
    return;
  }

  await runOllamaEval(projectRoot, args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
