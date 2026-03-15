"use strict";
/**
 * conversation_observer.js
 *
 * 分析群聊訊息批次，提取溝通風格特徵。
 * 純 heuristic，不呼叫 LLM，可在任何訊息後立即執行。
 *
 * 輸出格式：
 * {
 *   tone:       "playful" | "casual" | "thoughtful" | "heated"
 *   humor:      "heavy" | "light" | "none"
 *   energy:     "fast" | "medium" | "slow"
 *   lengthPref: "short" | "medium" | "long"
 *   emojiUse:   "heavy" | "light" | "none"
 *   sampleSize: number
 * }
 *
 * 設計原則：只提取語氣/節奏/互動模式，不存句子或個人觀點（避免人格漂移）。
 */

const EMOJI_RE    = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
const LAUGH_RE    = /哈哈|haha|lol|笑死|哈哈哈|xdd?|😂|🤣|hhh+/i;
const DEBATE_RE   = /不對|你錯|我覺得|但是|不過|其實|反而|才不是|根本/;
const QUESTION_RE = /[？?]/;
const URL_RE      = /https?:\/\/\S+/g;

/**
 * Filter: keep only substantive messages.
 * Removes bot messages, pure links, very short noise.
 */
function filterMessages(messages) {
  return messages.filter(m => {
    const t = String(m.text || "").replace(URL_RE, "").trim();
    return t.length >= 3 && !/^\d+$/.test(t);
  });
}

/**
 * Analyze a batch of group messages.
 * @param {Array<{text:string, username?:string, ts?:number}>} messages
 * @returns observation object
 */
function analyzeMessages(messages) {
  const msgs = filterMessages(messages);
  if (msgs.length === 0) return null;

  const n = msgs.length;

  // ── Message length ─────────────────────────────────────────────────────────
  const avgLen = msgs.reduce((s, m) => s + m.text.length, 0) / n;
  let lengthPref = "medium";
  if (avgLen < 15) lengthPref = "short";
  else if (avgLen > 50) lengthPref = "long";

  // ── Emoji density ──────────────────────────────────────────────────────────
  const emojiCount = msgs.reduce((s, m) => s + (m.text.match(EMOJI_RE) || []).length, 0);
  const emojiPerMsg = emojiCount / n;
  let emojiUse = "none";
  if (emojiPerMsg > 0.8) emojiUse = "heavy";
  else if (emojiPerMsg > 0.2) emojiUse = "light";

  // ── Humor / laughter ──────────────────────────────────────────────────────
  const laughCount = msgs.filter(m => LAUGH_RE.test(m.text)).length;
  const laughRatio = laughCount / n;
  let humor = "none";
  if (laughRatio > 0.3) humor = "heavy";
  else if (laughRatio > 0.12) humor = "light";

  // ── Tone ───────────────────────────────────────────────────────────────────
  const debateCount   = msgs.filter(m => DEBATE_RE.test(m.text)).length;
  const debateRatio   = debateCount / n;
  let tone = "casual";
  if (humor === "heavy")       tone = "playful";
  else if (debateRatio > 0.2)  tone = "heated";
  else if (avgLen > 50)        tone = "thoughtful";

  // ── Energy (message rhythm) ───────────────────────────────────────────────
  let energy = "medium";
  if (n >= 6 && avgLen < 20)  energy = "fast";   // rapid-fire short messages
  else if (avgLen > 60)       energy = "slow";   // long deliberate messages

  return { tone, humor, energy, lengthPref, emojiUse, sampleSize: n };
}

module.exports = { analyzeMessages };
