/**
 * self_preference_detector.js
 *
 * Detects preference expressions in 晴晴's own replies using fast LLM.
 * Fire-and-forget after each reply is generated.
 *
 * Detects patterns like:
 *   "我喜歡看..." / "我蠻喜歡..." / "我不太喜歡..." / "X好有趣" / "X有點無聊"
 *
 * Returns: [{ type: "like"|"dislike", item: string }] or []
 */

const axios = require("axios");

const ENDPOINT = process.env.OLLAMA_ENDPOINT || "http://localhost:11434/api/generate";
const FAST_MODEL = process.env.LLM_FAST_MODEL || "qwen2.5:3b";
const TIMEOUT_MS = 8000;

// Quick regex pre-filter — skip LLM call if no preference signal at all
const PREF_SIGNAL_RE = /喜歡|不喜歡|討厭|好有趣|好好玩|好可愛|有點無聊|蠻有趣|蠻喜歡|不太想|有點煩|挺好玩|挺有趣|挺喜歡|好看|好聽|好吃|有夠|超喜歡|超有趣/;

async function detectSelfPreferences(replyText = "") {
  const text = String(replyText || "").trim();
  if (!text || text.length < 10) return [];
  if (!PREF_SIGNAL_RE.test(text)) return [];

  const systemPrompt = `你是一個分析助手。任務：從以下AI回覆中，提取AI本身表達的個人喜好。
只提取AI自己的喜好，不是用戶的。
只提取清楚表達的喜好，不要推測。
回傳JSON陣列，格式：[{"type":"like","item":"具體喜好"},{"type":"dislike","item":"具體不喜歡的"}]
如果沒有明確喜好，回傳空陣列 []
item應該是簡短描述（2-20個字）。`;

  const userPrompt = `AI回覆：「${text}」\n\n請提取AI自己表達的喜好（JSON格式）：`;

  try {
    const resp = await axios.post(
      ENDPOINT,
      {
        model: FAST_MODEL,
        system: systemPrompt,
        prompt: userPrompt,
        stream: false,
        think: false,
        options: { temperature: 0.1, top_p: 0.9 },
      },
      { timeout: TIMEOUT_MS },
    );

    const raw = String(resp.data?.response || "").trim();
    // Extract JSON array from response
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p) => p && (p.type === "like" || p.type === "dislike") && p.item && p.item.length >= 2);
  } catch {
    return [];
  }
}

module.exports = { detectSelfPreferences };
