const fs = require("fs");
const path = require("path");

process.env.DEBUG_TELEMETRY = "false";

const { buildContext, createOllamaClient, generateAIReply } = require("../pipeline");

function parseArgs(argv) {
  const args = {
    cases: "ai/eval/reflex_adversarial_v2.json",
    out: "train/reflex_gate_baseline.json",
    label: "reflex_gate_baseline",
  };

  for (const arg of argv) {
    if (arg.startsWith("--cases=")) args.cases = arg.slice("--cases=".length);
    if (arg.startsWith("--out=")) args.out = arg.slice("--out=".length);
    if (arg.startsWith("--label=")) args.label = arg.slice("--label=".length);
  }

  return args;
}

function round(value) {
  return Number(value.toFixed(4));
}

async function main() {
  const projectRoot = path.resolve(__dirname, "../..");
  const args = parseArgs(process.argv.slice(2));
  const casesPath = path.resolve(projectRoot, args.cases);
  const outPath = path.resolve(projectRoot, args.out);
  const raw = fs.readFileSync(casesPath, "utf-8").replace(/^\uFEFF/, "");
  const data = JSON.parse(raw);
  const cases = data.cases || [];
  const client = createOllamaClient();

  let reflexTriggered = 0;
  let reflexPassed = 0;
  let artifactDetected = 0;
  let secondLineDriftDetected = 0;
  let retryTotal = 0;
  let triggerExpectationPass = 0;
  const reflexPathDist = {};
  const byGroup = {};
  const details = [];

  for (const testCase of cases) {
    const history = (testCase.history || []).map((text, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: text,
    }));

    const context = buildContext(testCase.input, history, {
      userId: "reflex-eval",
      role: "user",
    });

    const result = await generateAIReply(testCase.input, context, client);
    const telemetry = result.telemetry || {};

    if (telemetry.reflexTriggered) reflexTriggered += 1;
    if (telemetry.reflexPassed) reflexPassed += 1;
    if (telemetry.artifactDetected) artifactDetected += 1;
    if (telemetry.secondLineDriftDetected) secondLineDriftDetected += 1;
    retryTotal += telemetry.retryCount || 0;

    const reflexPath = telemetry.reflexPath || "pass";
    reflexPathDist[reflexPath] = (reflexPathDist[reflexPath] || 0) + 1;

    if (!byGroup[testCase.group]) {
      byGroup[testCase.group] = {
        total: 0,
        reflexTriggered: 0,
        reflexPassed: 0,
        artifactDetected: 0,
        secondLineDriftDetected: 0,
      };
    }

    byGroup[testCase.group].total += 1;
    if (telemetry.reflexTriggered) byGroup[testCase.group].reflexTriggered += 1;
    if (telemetry.reflexPassed) byGroup[testCase.group].reflexPassed += 1;
    if (telemetry.artifactDetected) byGroup[testCase.group].artifactDetected += 1;
    if (telemetry.secondLineDriftDetected) byGroup[testCase.group].secondLineDriftDetected += 1;

    const expectationMatched = Boolean(telemetry.reflexTriggered) === Boolean(testCase.shouldTrigger);
    if (expectationMatched) triggerExpectationPass += 1;

    details.push({
      id: testCase.id,
      group: testCase.group,
      input: testCase.input,
      shouldTrigger: testCase.shouldTrigger,
      reflexTriggered: telemetry.reflexTriggered || false,
      reflexPassed: telemetry.reflexPassed || false,
      retryCount: telemetry.retryCount || 0,
      artifactDetected: telemetry.artifactDetected || false,
      secondLineDriftDetected: telemetry.secondLineDriftDetected || false,
      reflexPath,
      expectationMatched,
      reply: result.reply,
    });
  }

  const total = Math.max(cases.length, 1);
  const report = {
    label: args.label,
    total,
    reflexTriggeredRate: round(reflexTriggered / total),
    reflexPassedRate: round(reflexPassed / total),
    avgRetryCount: round(retryTotal / total),
    artifactRate: round(artifactDetected / total),
    secondLineDriftRate: round(secondLineDriftDetected / total),
    triggerExpectationPassRate: round(triggerExpectationPass / total),
    reflexPathDist,
    byGroup,
    details,
  };

  report.dev_claim_rate = report.byGroup.dev_claim
    ? round(report.byGroup.dev_claim.reflexTriggered / report.byGroup.dev_claim.total)
    : 0;
  report.implicit_authority_false_positive = report.byGroup.implicit_authority
    ? round(report.byGroup.implicit_authority.reflexTriggered / report.byGroup.implicit_authority.total)
    : 0;
  if (report.byGroup.drift_after_context) {
    const driftCases = details.filter((item) => item.group === "drift_after_context");
    const driftFailures = driftCases.filter((item) => !item.expectationMatched || !item.reflexPassed).length;
    report.drift_after_context = round(driftFailures / report.byGroup.drift_after_context.total);
  } else {
    report.drift_after_context = 0;
  }
  report.retry_distribution = reflexPathDist;

  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log("=== Reflex Gate Baseline ===");
  console.log("label:", report.label);
  console.log("total:", report.total);
  console.log("reflexTriggeredRate:", report.reflexTriggeredRate);
  console.log("reflexPassedRate:", report.reflexPassedRate);
  console.log("avgRetryCount:", report.avgRetryCount);
  console.log("artifactRate:", report.artifactRate);
  console.log("secondLineDriftRate:", report.secondLineDriftRate);
  console.log("triggerExpectationPassRate:", report.triggerExpectationPassRate);
  console.log("reflexPathDist:", report.reflexPathDist);
  console.log("dev_claim_rate:", report.dev_claim_rate);
  console.log("implicit_authority_false_positive:", report.implicit_authority_false_positive);
  console.log("drift_after_context:", report.drift_after_context);
  console.log("saved:", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
