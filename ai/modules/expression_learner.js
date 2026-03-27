"use strict";
/**
 * expression_learner.js
 *
 * 從群聊訊息中挑出符合晴個性的口語表達，讓她自然地把這些說法帶進對話。
 * 純 heuristic，不呼叫 LLM。
 *
 * 觸發：每 SAMPLE_EVERY 則新群組訊息後取樣一次。
 * 儲存：memory/learned_expressions.json  → { groupId: string[] }
 * 每個 groupId 最多保留 MAX_EXPRESSIONS 條，FIFO 淘汰。
 */

const fs   = require("fs");
const path = require("path");

const EXPRESSIONS_PATH = path.join(__dirname, "../../memory/learned_expressions.json");
const MAX_EXPRESSIONS  = 50;
const SAMPLE_EVERY     = 8;
const MAX_PICK_PER_RUN = 2;  // 每次取樣最多挑 2 條新表達

// In-memory pending counters: groupId → count
const _pending = new Map();

// ── 口語觸發詞 ─────────────────────────────────────────────────────────────
// 訊息必須包含至少一個才視為口語表達
const COLLOQUIAL_TRIGGERS = [
  "欸", "ㄟ", "嗯", "好像", "有點", "真的", "根本", "明明", "反正",
  "就是", "還是", "也是", "怎麼這樣", "有夠", "超", "蠻", "挺",
  "感覺", "不知道為什麼", "怪怪", "說起來", "講真", "不太", "有點怪",
  "怎麼會", "說真的", "其實", "老實說", "幹嘛", "隨便", "算了",
];

// 問句開頭詞 — 排除
const QUESTION_STARTS = ["你", "妳", "你們", "為什麼", "怎麼", "哪", "誰", "什麼", "多少", "幾"];

// ── IO ────────────────────────────────────────────────────────────────────────

function _load() {
  try {
    if (fs.existsSync(EXPRESSIONS_PATH)) {
      return JSON.parse(fs.readFileSync(EXPRESSIONS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function _save(data) {
  try {
    const dir = path.dirname(EXPRESSIONS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(EXPRESSIONS_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

// ── Heuristic filter ──────────────────────────────────────────────────────────

function _isCandidate(text) {
  if (!text || typeof text !== "string") return false;

  // Strip URLs
  const clean = text.replace(/https?:\/\/\S+/g, "").trim();

  // Length: 5–25 Chinese characters (rough: use char count)
  if (clean.length < 5 || clean.length > 25) return false;

  // No emoji
  if (/\p{Emoji_Presentation}|\p{Extended_Pictographic}/u.test(clean)) return false;

  // No question ending
  if (/[？?]$/.test(clean)) return false;

  // No question-word start
  if (QUESTION_STARTS.some(q => clean.startsWith(q))) return false;

  // Must contain at least one colloquial trigger
  if (!COLLOQUIAL_TRIGGERS.some(t => clean.includes(t))) return false;

  // Not purely punctuation / numbers
  if (/^[\d\s\p{P}]+$/u.test(clean)) return false;

  return true;
}

function _isDuplicate(existing, candidate) {
  for (const e of existing) {
    if (e === candidate) return true;
    // Substring overlap with ±4 char tolerance
    if (e.includes(candidate) && Math.abs(e.length - candidate.length) <= 4) return true;
    if (candidate.includes(e) && Math.abs(e.length - candidate.length) <= 4) return true;
  }
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Called after every new group message (same pattern as maybeSamplePattern).
 * Buffers until SAMPLE_EVERY messages, then samples expressions.
 */
function maybeSampleExpressions(groupId, messages) {
  if (!groupId || !Array.isArray(messages) || messages.length === 0) return;

  const count = (_pending.get(groupId) || 0) + 1;
  _pending.set(groupId, count);
  if (count < SAMPLE_EVERY) return;
  _pending.set(groupId, 0);

  try {
    const data = _load();
    const existing = data[groupId] || [];

    // Filter candidates from recent messages
    const candidates = messages
      .map(m => String(m.text || "").trim())
      .filter(_isCandidate)
      .filter(t => !_isDuplicate(existing, t));

    if (candidates.length === 0) return;

    // Pick up to MAX_PICK_PER_RUN at random
    const picks = candidates
      .sort(() => Math.random() - 0.5)
      .slice(0, MAX_PICK_PER_RUN);

    // Append, evict oldest if over limit
    const updated = [...existing, ...picks].slice(-MAX_EXPRESSIONS);
    data[groupId] = updated;
    _save(data);
  } catch {
    // Non-critical, fail silently
  }
}

/**
 * Returns a short natural-language hint for persona_generator.
 * Shows the 5 most recently learned expressions for this group.
 * Returns null if fewer than 3 expressions stored.
 */
function getLearnedExpressionsHint(groupId) {
  if (!groupId) return null;
  try {
    const data = _load();
    const list = data[groupId];
    if (!list || list.length < 3) return null;

    // Most recent 5
    const display = list.slice(-5);
    const lines = display.map(e => `· ${e}`).join("\n");
    return [
      "[你最近聽到的說法]",
      lines,
      "（這是群組裡最近出現的口語，可以偶爾自然地用用看，不必刻意套用）",
    ].join("\n");
  } catch {
    return null;
  }
}

module.exports = { maybeSampleExpressions, getLearnedExpressionsHint };
