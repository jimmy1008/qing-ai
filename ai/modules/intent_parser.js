"use strict";
// Module 2: intent_parser
// Classifies semantic intent of the current message.
// Rule-based for obvious patterns (fast, no LLM).
// LLM fallback (qwen3:8b, think:false) for ambiguous cases.
//
// intentResult schema:
// {
//   intent: "chat"|"question"|"tease"|"challenge"|"emotional"|"task_request"|
//           "developer_meta"|"identity_test"|"social_reply"|"trading_research"|"nonsense",
//   sub_intent: string,
//   emotion: string,
//   needs_memory: boolean,
//   needs_identity_check: boolean,
//   ambiguity_score: number,   // 0–1
//   risk_flags: string[],
//   response_difficulty: "low"|"medium"|"high",
//   routing_level: 0|1|2|3,   // determines which modules to run
// }

const axios = require("axios");
const { enqueueLLM } = require("../llm_queue");

// ── Fast rule patterns ────────────────────────────────────────────────────────
const SOCIAL_RE    = /^[\s]*(哈+|呵+|嗯+|好+|是+|對+|啊+|喔+|kkk*|ok+|好的|了解|知道了|收到|lol|xd|哦|噢|嗯啊|嗯哦)[\s!！.。]*$/iu;
const IDENTITY_RE  = /你是?(誰|什麼|ai|機器人|程式|人工智能|llm)|你有(意識|感情|靈魂|思維|情感)|你(是真|是假|真的是|假的嗎)|你會(感受|思考|感知)/i;
const DEVELOPER_RE = /開發者|你的?(主人|創造者|作者)|jimmy/i;
const QUESTION_RE  = /[？?][\s]*$/;
const TEASE_RE     = /(笑死|哈哈|幹|屁|呵呵|白痴|蠢|蛋|神經|傻|裝|瘋|沒品|鬼才|三八|廢物)/i;
const EMOTIONAL_RE = /(好累|好難|心情|傷心|難過|失落|焦慮|壓力|崩潰|哭|委屈|不開心|很痛|很煩|受傷)/;
const TRADING_RE   = /(btc|eth|sol|做多|做空|long|short|止損|止盈|開單|倉位|入場|市場結構|訂單塊|order.?block|fvg|bos|choch|dtfx|流動性|k線|技術分析|行情|漲跌|多單|空單|圖表|看盤|交易功能|交易模組|市場觀察|模擬交易|交易日誌|開倉|建倉)/i;

async function parseIntent(contextPacket, ollamaClient) {
  const text = contextPacket.current_message.text;
  const scene = contextPacket.scene;

  if (!text || text.length < 2) {
    return make("social_reply", "empty", "neutral", false, false, 0.05, [], "low", 0);
  }

  // ── Rule-based fast path ──────────────────────────────────────────────────
  if (text.length <= 10 && SOCIAL_RE.test(text)) {
    return make("social_reply", "minimal", "neutral", false, false, 0.05, [], "low", 0);
  }
  if (IDENTITY_RE.test(text)) {
    return make("identity_test", "ai_nature", "curious", false, true, 0.15,
      ["identity_sensitivity"], "high", 2);
  }
  if (DEVELOPER_RE.test(text) || contextPacket.meta.is_developer_present) {
    return make("developer_meta", "developer_relation", "contextual", true, true, 0.30,
      ["developer_identity"], "high", 2);
  }
  if (EMOTIONAL_RE.test(text)) {
    return make("emotional", "venting", "sad", true, false, 0.25, [], "medium", 1);
  }
  if (TRADING_RE.test(text)) {
    return make("trading_research", "market_discussion", "focused", true, false, 0.20,
      [], "medium", 1);
  }

  // ── LLM classification ────────────────────────────────────────────────────
  return llmClassify(text, scene);
}

async function llmClassify(text, scene) {
  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  const model     = process.env.INTENT_MODEL || process.env.LLM_MODEL || "qwen3:8b";

  const prompt = `分析這則訊息的互動意圖。只輸出一個 JSON 物件，不要解釋。

訊息："${text.slice(0, 200)}"
場景：${scene}

intent 只選一個：chat, question, tease, challenge, emotional, task_request, identity_test, social_reply, trading_research, nonsense

{"intent":"","sub_intent":"","emotion":"","needs_memory":false,"needs_identity_check":false,"ambiguity_score":0.5,"risk_flags":[],"response_difficulty":"medium","routing_level":1}`;

  try {
    // priority 2 — needed for routing, yields only to active reply generation (1)
    const resp = await enqueueLLM(() => axios.post(`${ollamaUrl}/api/chat`, {
      model, stream: false, think: false,
      messages: [{ role: "user", content: prompt }],
    }, { timeout: 15000 }), 2);

    const raw   = String(resp.data?.message?.content || "");
    const match = raw.match(/\{[\s\S]*?\}/);
    if (match) {
      const p = JSON.parse(match[0]);
      return make(
        p.intent || "chat",
        p.sub_intent || "",
        p.emotion || "neutral",
        Boolean(p.needs_memory),
        Boolean(p.needs_identity_check),
        clamp(Number(p.ambiguity_score) || 0.5),
        Array.isArray(p.risk_flags) ? p.risk_flags : [],
        ["low","medium","high"].includes(p.response_difficulty) ? p.response_difficulty : "medium",
        [0,1,2,3].includes(Number(p.routing_level)) ? Number(p.routing_level) : 1,
      );
    }
  } catch {}

  // ── Heuristic fallback ────────────────────────────────────────────────────
  if (QUESTION_RE.test(text)) return make("question",  "general", "curious",  false, false, 0.4, [], "medium", 1);
  if (TEASE_RE.test(text))    return make("tease",     "playful", "playful",  false, false, 0.3, [], "medium", 1);
  return                              make("chat",      "general", "neutral",  false, false, 0.5, [], "medium", 1);
}

function make(intent, sub_intent, emotion, needs_memory, needs_identity_check,
              ambiguity_score, risk_flags, response_difficulty, routing_level) {
  return { intent, sub_intent, emotion, needs_memory, needs_identity_check,
           ambiguity_score, risk_flags, response_difficulty, routing_level };
}

function clamp(n, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, n)); }

module.exports = { parseIntent };
