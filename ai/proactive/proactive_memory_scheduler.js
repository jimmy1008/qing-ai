"use strict";

const fs = require("fs");
const path = require("path");
const { getEpisodes } = require("../episodic_store");
const { appendLine } = require("../memory_service");
const { selectProactiveCandidates } = require("./proactive_memory_selector");
const { buildProactiveMessage } = require("./proactive_message_builder");

const EPISODES_DIR = path.join(__dirname, "../../memory/episodes");
const OUTBOX_PATH = path.join(__dirname, "../../memory/proactive_outbox.jsonl");
const MIN_INTERVAL_MS = Number(process.env.PROACTIVE_MEMORY_MIN_INTERVAL_MS || 10 * 60 * 1000);

let _timer = null;

function listUserKeys() {
  if (!fs.existsSync(EPISODES_DIR)) return [];
  return fs.readdirSync(EPISODES_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""));
}

async function runMemoryDrivenProactiveTick() {
  const keys = listUserKeys().slice(0, 20);
  for (const key of keys) {
    const episodes = getEpisodes(key);
    if (!episodes.length) continue;

    const candidates = selectProactiveCandidates(key, episodes, Date.now());
    const candidate = candidates.followups[0] || candidates.anniversary[0] || candidates.milestoneRecalls[0];
    if (!candidate) continue;

    const type = candidates.followups[0] ? "followup" : (candidates.anniversary[0] ? "anniversary" : "milestone_recall");
    const text = await buildProactiveMessage({ globalUserKey: key, candidate, type });
    if (!text) continue;

    await appendLine(OUTBOX_PATH, JSON.stringify({
      ts: Date.now(),
      globalUserKey: key,
      type,
      sourceEpisodeId: candidate.id,
      text,
      status: "pending",
    })).catch(() => {});
  }
}

function startMemoryDrivenProactiveScheduler() {
  if (_timer) return;
  _timer = setInterval(() => {
    runMemoryDrivenProactiveTick().catch(() => {});
  }, MIN_INTERVAL_MS);
}

function stopMemoryDrivenProactiveScheduler() {
  if (!_timer) return;
  clearInterval(_timer);
  _timer = null;
}

module.exports = {
  runMemoryDrivenProactiveTick,
  startMemoryDrivenProactiveScheduler,
  stopMemoryDrivenProactiveScheduler,
};
