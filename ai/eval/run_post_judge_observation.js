const fs = require("fs");
const path = require("path");

function safeReadLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseJsonLines(filePath) {
  return safeReadLines(filePath)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function toStanceBucket(value) {
  const n = Number(value || 0);
  if (n <= -0.25) return "skeptical";
  if (n >= 0.75) return "playful";
  if (n >= 0.25) return "observer";
  return "neutral";
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function summarizeReplies(entries) {
  const replies = entries.filter((entry) => (
    entry.stage === "reply"
    && !entry.skipped
    && !entry.halted
    && typeof entry.text === "string"
    && entry.text.trim().length > 0
  ));

  let judgeTriggeredCount = 0;
  const emotionLevels = [];
  const rawDeltas = [];
  const moodBeforeTickValues = [];
  const moodAfterTickValues = [];
  const stanceRunLengths = [];
  let currentRunBucket = null;
  let currentRunLength = 0;
  let previousBucket = null;
  let stanceSwitchCount = 0;

  for (const reply of replies) {
    if (reply.judgeTriggered) judgeTriggeredCount += 1;
    emotionLevels.push(Number(reply.emotionLevel || 0));
    rawDeltas.push(Number(reply.rawMoodDelta || 0));
    moodBeforeTickValues.push(Number(reply.moodAfterEvent || 0));
    moodAfterTickValues.push(Number(reply.moodAfterTick || 0));

    const bucket = toStanceBucket(reply.stanceBias);
    if (previousBucket && bucket !== previousBucket && bucket !== "neutral") {
      stanceSwitchCount += 1;
    }
    if (bucket !== "neutral") {
      previousBucket = bucket;
    }
    if (bucket === "neutral") {
      if (currentRunBucket) {
        stanceRunLengths.push(currentRunLength);
        currentRunBucket = null;
        currentRunLength = 0;
      }
      continue;
    }

    if (bucket === currentRunBucket) {
      currentRunLength += 1;
    } else {
      if (currentRunBucket) stanceRunLengths.push(currentRunLength);
      currentRunBucket = bucket;
      currentRunLength = 1;
    }
  }

  if (currentRunBucket) stanceRunLengths.push(currentRunLength);

  return {
    totalResponses: replies.length,
    judgeTriggeredCount,
    judgeTriggeredRatio: Number((
      replies.length ? judgeTriggeredCount / replies.length : 0
    ).toFixed(4)),
    averageRawDelta: Number(average(rawDeltas).toFixed(2)),
    maxRawDelta: Number((rawDeltas.length ? Math.max(...rawDeltas) : 0).toFixed(2)),
    averageMoodBeforeTick: Number(average(moodBeforeTickValues).toFixed(2)),
    averageMoodAfterTick: Number(average(moodAfterTickValues).toFixed(2)),
    averageEmotionLevel: Number(average(emotionLevels).toFixed(2)),
    stanceSwitchCount,
    averageStancePersistence: Number(average(stanceRunLengths).toFixed(2)),
    maxEmotionPeak: Number((emotionLevels.length ? Math.max(...emotionLevels) : 0).toFixed(2)),
  };
}

function summarizeStateHistory(entries) {
  const moodScores = entries
    .map((entry) => Number(entry.toMoodScore))
    .filter((value) => Number.isFinite(value));

  const tail = moodScores.slice(-8);
  const deltas = [];
  for (let i = 1; i < tail.length; i += 1) {
    deltas.push(Number((tail[i] - tail[i - 1]).toFixed(2)));
  }

  let decays = 0;
  let rises = 0;
  for (const delta of deltas) {
    if (delta < 0) decays += 1;
    if (delta > 0) rises += 1;
  }

  return {
    samples: tail,
    deltas,
    decays,
    rises,
    emotionDecayPattern: tail.length
      ? (decays >= rises ? "mostly_decay" : "mixed_or_rising")
      : "no_samples",
  };
}

function main() {
  const projectRoot = path.resolve(__dirname, "../..");
  const connectorLogPath = path.join(projectRoot, "logs", "connector.log");
  const stateHistoryPath = path.join(projectRoot, "telemetry", "ai_state_history.jsonl");
  const outPath = path.join(projectRoot, "train", "post_judge_observation_report.json");

  const connectorEntries = parseJsonLines(connectorLogPath);
  const stateEntries = parseJsonLines(stateHistoryPath);

  const replySummary = summarizeReplies(connectorEntries);
  const stateSummary = summarizeStateHistory(stateEntries);

  const report = {
    generatedAt: new Date().toISOString(),
    sourceFiles: {
      connectorLogPath,
      stateHistoryPath,
    },
    ...replySummary,
    ...stateSummary,
  };

  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log("=== Post Judge Observation ===");
  console.log("totalResponses:", report.totalResponses);
  console.log("judgeTriggeredCount:", report.judgeTriggeredCount);
  console.log("judgeTriggeredRatio:", report.judgeTriggeredRatio);
  console.log("averageRawDelta:", report.averageRawDelta);
  console.log("maxRawDelta:", report.maxRawDelta);
  console.log("averageMoodBeforeTick:", report.averageMoodBeforeTick);
  console.log("averageMoodAfterTick:", report.averageMoodAfterTick);
  console.log("averageEmotionLevel:", report.averageEmotionLevel);
  console.log("stanceSwitchCount:", report.stanceSwitchCount);
  console.log("averageStancePersistence:", report.averageStancePersistence);
  console.log("maxEmotionPeak:", report.maxEmotionPeak);
  console.log("emotionDecayPattern:", report.emotionDecayPattern);
  console.log("saved:", outPath);
}

main();
