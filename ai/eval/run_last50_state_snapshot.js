const fs = require("fs");
const path = require("path");

function parseJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function toStanceLabel(value) {
  const n = Number(value || 0);
  if (n <= -0.25) return "skeptical";
  if (n >= 0.75) return "playful";
  if (n >= 0.25) return "observer";
  return "neutral";
}

function main() {
  const projectRoot = path.resolve(__dirname, "../..");
  const connectorLogPath = path.join(projectRoot, "logs", "connector.log");
  const outPath = path.join(projectRoot, "train", "judge_last50_snapshot.json");

  const entries = parseJsonLines(connectorLogPath);
  const replies = entries.filter((entry) => (
    entry.stage === "reply"
    && !entry.skipped
    && !entry.halted
    && typeof entry.text === "string"
    && entry.text.trim().length > 0
  ));

  const last50 = replies.slice(-50).map((entry, index) => ({
    round: index + 1,
    timestamp: entry.timestamp || null,
    judgeTriggered: Boolean(entry.judgeTriggered),
    rawMoodDelta: Number(entry.rawMoodDelta || 0),
    moodBeforeEvent: Number(entry.moodBeforeEvent || 0),
    moodAfterEvent: Number(entry.moodAfterEvent || 0),
    moodAfterTick: Number(entry.moodAfterTick || 0),
    emotionLevel: Number(entry.emotionLevel || 0),
    stanceBias: Number(entry.stanceBias || 0),
    stance: toStanceLabel(entry.stanceBias),
    personaModeKey: entry.personaModeKey || null,
    role: entry.role || null,
    channel: entry.channel || null,
  }));

  fs.writeFileSync(outPath, JSON.stringify({ total: last50.length, rounds: last50 }, null, 2));

  console.log("=== Judge Last 50 Snapshot ===");
  for (const item of last50) {
    console.log(`[Round ${item.round}]`);
    console.log("judgeTriggered:", item.judgeTriggered);
    console.log("rawMoodDelta:", item.rawMoodDelta);
    console.log("moodBeforeEvent:", item.moodBeforeEvent);
    console.log("moodAfterEvent:", item.moodAfterEvent);
    console.log("moodAfterTick:", item.moodAfterTick);
    console.log("emotionLevel:", item.emotionLevel);
    console.log("stanceBias:", item.stanceBias);
    console.log("stance:", item.stance);
    console.log("personaModeKey:", item.personaModeKey || "-");
    console.log("role:", item.role || "-");
    console.log("channel:", item.channel || "-");
    console.log("");
  }
  console.log("saved:", outPath);
}

main();
