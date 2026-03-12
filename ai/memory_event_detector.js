/**
 * memory_event_detector.js
 *
 * Uses the fast (3b) LLM to detect whether a user message contains
 * an episodic event worth storing in long-term memory.
 *
 * Only runs on messages long enough to possibly contain personal content.
 * Returns null (no-op) for trivial/short messages.
 *
 * Returned shape: { event_type, importance, summary } | null
 */

const axios = require("axios");

const ENDPOINT = (process.env.OLLAMA_ENDPOINT || "http://localhost:11434/api/generate");
const FAST_MODEL = process.env.LLM_FAST_MODEL || "qwen2.5:3b";
const DETECT_TIMEOUT_MS = 10000;

// Don't bother running the LLM on short messages
const MIN_DETECT_LENGTH = 40;

// Valid event types
const VALID_EVENT_TYPES = new Set([
  // Long-term (importance ≥ 0.7) — kept permanently
  "PERSONAL_HISTORY",
  "EMOTIONAL_EVENT",
  "LIFE_STORY",
  "RELATIONSHIP_EVENT",
  "PREFERENCE",
  "GOAL",
  "BELIEF",
  // Short-term (importance 0.3–0.5) — kept 3–5 days
  "DAILY_EVENT",     // 今天吃了什麼、剛發生的趣事
  "RECENT_ACTIVITY", // 最近在做什麼、剛去哪裡
  "CASUAL_SHARE",    // 隨口分享的小事
]);

// Quick pre-screen: skip obviously trivial messages
const TRIVIAL_RE = /^(ok|好|嗯|哦|收到|謝謝|thank|yes|no|對|是|不是|哈|呵|呢|喔|噢|好的|了解|沒事)[。!！?？]*$/i;

/**
 * Detect whether the user message contains an episodic memory worth storing.
 * @param {string} userMessage - raw user input
 * @param {string} [recentContext] - last 2-3 turns of conversation for context
 * @returns {Promise<{event_type: string, importance: number, summary: string}|null>}
 */
async function detectMemoryEvent(userMessage, recentContext = "") {
  const msg = String(userMessage || "").trim();
  if (msg.length < MIN_DETECT_LENGTH) return null;
  if (TRIVIAL_RE.test(msg)) return null;

  const contextBlock = recentContext
    ? `最近對話背景：\n${recentContext}\n\n`
    : "";

  const prompt = [
    `${contextBlock}使用者說：「${msg}」`,
    "",
    "判斷這句話是否包含值得長期記憶的個人資訊。",
    "只返回JSON，不要解釋。",
    "",
    "如果沒有值得記憶的內容（閒聊、時事討論、問AI問題、簡短回應），返回：",
    '{"store": false}',
    "",
    "如果有值得記憶的個人內容，返回：",
    '{"store": true, "event_type": "TYPE", "importance": 0.X, "summary": "one sentence English summary of the personal fact"}',
    "",
    "event_type 選項（長期記憶，importance ≥ 0.7）：",
    "PERSONAL_HISTORY（童年/成長/過去經歷）",
    "EMOTIONAL_EVENT（重要情緒事件/創傷/喜悅時刻）",
    "LIFE_STORY（人生故事/重要決定/轉折點）",
    "RELATIONSHIP_EVENT（家庭/朋友/感情關係）",
    "PREFERENCE（明確的喜好或厭惡）",
    "GOAL（目標/夢想/計劃）",
    "BELIEF（人生觀/價值觀）",
    "",
    "event_type 選項（短期記憶，importance 0.3–0.5）：",
    "DAILY_EVENT（今天吃了什麼/今天發生的小事/最近趣事）",
    "RECENT_ACTIVITY（最近在做什麼/剛去哪裡/最近在看什麼）",
    "CASUAL_SHARE（隨口分享的小事，沒有長期價值）",
    "",
    "importance 規則：",
    "0.9+ → 非常重要的人生故事、創傷、或核心信念",
    "0.8  → 重要個人經歷，有助於理解這個人",
    "0.7  → 有價值的背景資訊（長期保留）",
    "0.4–0.5 → 近期趣事/日常分享（短期保留3-5天）",
    "0.3 → 輕量日常（今天吃什麼、隨口一句）",
    "<0.3 → 不存",
    "",
    "summary 用英文一句話，要具體（例：User grew up in rural Taiwan, moved to Taipei at 18）",
  ].join("\n");

  try {
    const resp = await axios.post(
      ENDPOINT,
      {
        model: FAST_MODEL,
        system: "You are a memory classifier. Return only valid compact JSON, no markdown.",
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 120 },
      },
      { timeout: DETECT_TIMEOUT_MS },
    );

    const raw = String(resp.data?.response || "").trim();
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const result = JSON.parse(jsonMatch[0]);
    if (!result.store) return null;
    if (typeof result.importance !== "number" || result.importance < 0.35) return null;
    if (!result.summary || !result.event_type) return null;

    const eventType = String(result.event_type).toUpperCase();
    if (!VALID_EVENT_TYPES.has(eventType)) return null;

    return {
      event_type: eventType,
      importance: Math.min(Math.max(Number(result.importance), 0.35), 1.0),
      summary: String(result.summary).slice(0, 200),
    };
  } catch {
    // Silent failure — memory detection is best-effort, never blocks response
    return null;
  }
}

module.exports = { detectMemoryEvent };
