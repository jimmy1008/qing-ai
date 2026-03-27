"use strict";
// Module 2: intent_parser
// Classifies semantic intent of the current message.
// Fully rule-based — no LLM call. Normal path latency: 0ms.
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

// ── Rule patterns ─────────────────────────────────────────────────────────────
const SOCIAL_RE    = /^[\s]*(哈+|呵+|嗯+|好+|是+|對+|啊+|喔+|kkk*|ok+|好的|了解|知道了|收到|lol|xd|哦|噢|嗯啊|嗯哦)[\s!！.。]*$/iu;
const IDENTITY_RE  = /你是?(誰|什麼|ai|機器人|程式|人工智能|llm)|你有(意識|感情|靈魂|思維|情感)|你(是真|是假|真的是|假的嗎)|你會(感受|思考|感知)/i;
const DEVELOPER_RE = /開發者|你的?(主人|創造者|作者)|jimmy/i;
const EMOTIONAL_RE = /(好累|好難|心情|傷心|難過|失落|焦慮|壓力|崩潰|哭|委屈|不開心|很痛|很煩|受傷)/;
const TRADING_RE   = /(btc|eth|sol|做多|做空|long|short|止損|止盈|開單|倉位|入場|市場結構|訂單塊|order.?block|fvg|bos|choch|dtfx|流動性|k線|技術分析|行情|漲跌|多單|空單|圖表|看盤|交易功能|交易模組|市場觀察|模擬交易|交易日誌|開倉|建倉|你的?策略|你在學|學交易|你的?勝率|你的?反思|你的?交易|交易進度|學了什麼|學到什麼|你的?模擬|你有沒有(在學|在交易)|你最近在學|你的(倉|看法|方法|心得))/i;
const CHALLENGE_RE = /(不對|才不是|你錯了|你說錯|那不對|根本不是|胡說|亂講|哪有|你憑什麼|不可能|不信|懷疑你|證明|反駁|辯論|為什麼你|你確定嗎)/i;
const TASK_RE      = /(幫我|請問|能不能|可以幫|麻煩你|查一下|告訴我|解釋|翻譯|計算|分析一下|怎麼做|如何|步驟|教我|寫一個|生成|製作)/i;
const TEASE_RE     = /(笑死|哈哈|幹|屁|呵呵|白痴|蠢|蛋|神經|傻|裝|瘋|沒品|鬼才|三八|廢物)/i;
const QUESTION_RE  = /[？?][\s]*$/;
const NONSENSE_RE  = /^[^\w\u4e00-\u9fff]{1,5}$|^(.)\1{4,}$/u; // pure symbols / repeated chars

function parseIntent(contextPacket) {
  const text = contextPacket.current_message.text;

  if (!text || text.length < 2) {
    return make("social_reply", "empty", "neutral", false, false, 0.05, [], "low", 0);
  }

  // ── Priority-ordered rule matching ────────────────────────────────────────
  if (text.length <= 10 && SOCIAL_RE.test(text)) {
    return make("social_reply", "minimal", "neutral", false, false, 0.05, [], "low", 0);
  }
  if (NONSENSE_RE.test(text.trim()) && text.trim().length <= 8) {
    return make("nonsense", "noise", "neutral", false, false, 0.05, [], "low", 0);
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
  if (CHALLENGE_RE.test(text)) {
    return make("challenge", "dispute", "assertive", true, false, 0.35,
      [], "high", 2);
  }
  if (TASK_RE.test(text)) {
    return make("task_request", "assist", "neutral", true, false, 0.20,
      [], "medium", 1);
  }
  if (TEASE_RE.test(text)) {
    return make("tease", "playful", "playful", false, false, 0.30, [], "medium", 1);
  }
  if (QUESTION_RE.test(text)) {
    return make("question", "general", "curious", false, false, 0.40, [], "medium", 1);
  }

  // ── Default: general conversation ─────────────────────────────────────────
  return make("chat", "general", "neutral", false, false, 0.50, [], "medium", 1);
}

function make(intent, sub_intent, emotion, needs_memory, needs_identity_check,
              ambiguity_score, risk_flags, response_difficulty, routing_level) {
  return { intent, sub_intent, emotion, needs_memory, needs_identity_check,
           ambiguity_score, risk_flags, response_difficulty, routing_level };
}

module.exports = { parseIntent };
