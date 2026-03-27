"use strict";
/**
 * trade_lessons.js
 *
 * Conversation-triggered strategy lesson extraction.
 *
 * When the user critiques 晴's trade execution in conversation,
 * this module extracts the underlying **principle** (not specific numbers)
 * and persists it for future injection into trading context.
 *
 * Example:
 *   User: "你為什麼開在那邊？按DTFX應該等回踩到73811再進"
 *   Extracted principle: "入場前需等回踩確認OB，不應在趨勢延伸處搶進"
 *
 * Storage: memory/trades/lessons.jsonl
 * Injection: recent N lessons prepended to trading_self context block
 */

const fs   = require("fs");
const path = require("path");
const axios = require("axios");

const LESSONS_FILE = path.join(__dirname, "../../../memory/trades/lessons.jsonl");
const MAX_INJECT   = 4;   // how many recent lessons to inject per turn
const MAX_LESSONS  = 30;  // cap file at this many entries (drop oldest)

// ── Trigger detection ─────────────────────────────────────────────────────────
// Matches when user is critiquing 晴's trade execution or strategy.
// Intentionally broad — false positives are cheap (LLM extraction will just
// return a weak/empty lesson if there's nothing actionable).
const CRITIQUE_RE = /(你為什麼.{0,15}(開|進場|那邊|那個位置|止損|那裡)|進場.{0,8}(太早|太急|不對|有問題|搶了)|止損.{0,8}(太近|太遠|設錯|不對)|策略.{0,5}(有問題|不對|不符合)|應該等.{0,10}(再進|回踩|確認)|沒(等到|等回踩|確認)|這樣不符合dtfx|按照dtfx)/i;

/**
 * Returns true when the user message looks like trade execution critique.
 * @param {string} userText
 * @param {string} intent
 */
function isTradeCritique(userText, intent) {
  if (intent !== "trading_research") return false;
  return CRITIQUE_RE.test(userText);
}

// ── Storage helpers ────────────────────────────────────────────────────────────

function readAll() {
  try {
    if (!fs.existsSync(LESSONS_FILE)) return [];
    return fs.readFileSync(LESSONS_FILE, "utf8")
      .split("\n").filter(Boolean)
      .map(l => JSON.parse(l));
  } catch { return []; }
}

function writeAll(entries) {
  try {
    fs.mkdirSync(path.dirname(LESSONS_FILE), { recursive: true });
    fs.writeFileSync(LESSONS_FILE, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  } catch { /* ignore */ }
}

/**
 * Returns the N most recent lessons for prompt injection.
 * @returns {string[]} lesson strings in 晴's first person
 */
function getRecentLessons(n = MAX_INJECT) {
  return readAll().slice(-n).map(e => e.lesson);
}

// ── LLM extraction ────────────────────────────────────────────────────────────

/**
 * Uses fast model to extract an actionable trading principle from user critique.
 * Returns null if nothing actionable is found.
 *
 * @param {string} userFeedback  — the user's critique message
 * @param {string} tradeContext  — brief trade data string (pair/direction/entry/stop)
 */
async function extractPrinciple(userFeedback, tradeContext) {
  const ollamaUrl = process.env.OLLAMA_URL    || "http://localhost:11434";
  const fastModel = process.env.LLM_FAST_MODEL || "qwen2.5:3b";

  const prompt = [
    "以下是一次交易對話中對方指出的問題：",
    `「${userFeedback.slice(0, 300)}」`,
    tradeContext ? `相關倉位：${tradeContext}` : "",
    "",
    "請從這個具體問題中，提取一條可以用於未來的交易執行原則。",
    "要求：",
    "- 不要記住這次的具體數字（價格/點位），而是說明背後的操作邏輯",
    "- 用第一人稱，30字以內，口語中文",
    "- 只輸出原則本身，不要說明或前綴",
    "例：「等到回踩確認 OB 後再進場，不在趨勢延伸區域搶入」",
    "如果指出的不是執行問題（例如只是問數據），請輸出：SKIP",
  ].filter(Boolean).join("\n");

  try {
    const resp = await axios.post(`${ollamaUrl}/api/generate`, {
      model: fastModel,
      prompt,
      stream: false,
      options: { temperature: 0.4, num_predict: 80 },
    }, { timeout: 15000 });

    const text = String(resp.data?.response || "").trim().split("\n")[0];
    if (!text || text === "SKIP" || text.length < 6 || text.length > 100) return null;
    return text;
  } catch { return null; }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget: extract and save a lesson from user critique.
 * Should be called from 08_repair.js after pipeline completes.
 *
 * @param {string} userFeedback
 * @param {string|null} tradeContext  — brief summary of open positions
 */
async function maybeLearnFromCritique(userFeedback, tradeContext) {
  const principle = await extractPrinciple(userFeedback, tradeContext);
  if (!principle) return;

  const existing = readAll();

  // Deduplicate: skip if very similar lesson already stored (simple substring check)
  const isDuplicate = existing.some(e =>
    e.lesson.length > 10 && principle.includes(e.lesson.slice(0, 12))
  );
  if (isDuplicate) return;

  const entry = {
    ts:       Date.now(),
    feedback: userFeedback.slice(0, 150),
    lesson:   principle,
  };

  const updated = [...existing, entry].slice(-MAX_LESSONS);
  writeAll(updated);
}

module.exports = { isTradeCritique, getRecentLessons, maybeLearnFromCritique };
