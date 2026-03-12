/**
 * message_classifier.js
 * Rule-based (no LLM) classifier for incoming user messages.
 * Returns { intent, emotion, subtext, ambiguityScore }
 *
 * Used to inject [UserMessageState] into system prompt so the AI
 * knows what the user is actually doing/feeling before generating a reply.
 */

// ─── Intent ──────────────────────────────────────────────────────────────────

const INTENT_RULES = [
  { intent: "greeting",   pattern: /^(你好|嗨|哈囉|hi|hello|hey|在嗎|在不在|醒了|睡了嗎)[!！。?？\s]*$/i },
  { intent: "venting",    pattern: /(好煩|煩死|崩潰|受不了|超累|好難|心好累|沒力|討厭|氣死|難受|不想了|撐不住|快瘋了|心情很差|很煩)/ },
  { intent: "excited",    pattern: /(好棒|超讚|太好了|哇[哦喔]?|感動|太屌|好厲害|成功了|終於|爽[死爆啊]?)/ },
  { intent: "joking",     pattern: /(哈哈|笑死|笑了|XD|xd|搞笑|哈哈哈|幹好笑|好扯|哈)/ },
  { intent: "asking",     pattern: /[？?]|^(為什麼|怎麼|誰|哪裡|什麼|幾點|多少|可以嗎|對嗎|真的嗎|有沒有)/ },
  { intent: "sharing",    pattern: /(我今天|剛才|我發現|我看到|我遇到|跟你說|你知道嗎|對了|結果|後來)/ },
  { intent: "validating", pattern: /(對嗎|有道理嗎|你覺得怎樣|你認為|我這樣做對嗎|你說呢)/ },
  { intent: "chatting",   pattern: // catch-all
    /[\u4e00-\u9fff]/ },
];

function classifyIntent(text = "") {
  const t = String(text || "").trim();
  for (const { intent, pattern } of INTENT_RULES) {
    if (pattern.test(t)) return intent;
  }
  return "chatting";
}

// ─── Emotion ─────────────────────────────────────────────────────────────────

const EMOTION_RULES = [
  { emotion: "tired",      pattern: /(累|疲[憊乏]?|沒力|好累|倦|撐不住|睡不夠|沒睡)/ },
  { emotion: "frustrated", pattern: /(煩|煩死|氣[死炸]?|受不了|崩潰|討厭|幹|去你的|被搞死)/ },
  { emotion: "anxious",    pattern: /(焦慮|擔心|緊張|怕|不安|慌|壓力|怕怕)/ },
  { emotion: "sad",        pattern: /(難過|傷心|哭了|悲|委屈|心疼|難受|低落)/ },
  { emotion: "happy",      pattern: /(開心|高興|好棒|爽|感動|讚|棒|快樂|興奮)/ },
  { emotion: "bored",      pattern: /(無聊|沒事做|閒|好悶|沒什麼|就那樣)/ },
];

function classifyEmotion(text = "") {
  const t = String(text || "").trim();
  for (const { emotion, pattern } of EMOTION_RULES) {
    if (pattern.test(t)) return emotion;
  }
  return "neutral";
}

// ─── Subtext ─────────────────────────────────────────────────────────────────

function detectSubtext(text = "", history = []) {
  const t = String(text || "").trim();
  const recentUser = history
    .filter((h) => h.role === "user")
    .slice(-5)
    .map((h) => String(h.text || ""));

  const allRecent = [...recentUser, t].join(" ");

  // Repeated tiredness across turns → wants to vent, not advice
  const tiredCount = (allRecent.match(/(累|疲|沒力|好累|倦)/g) || []).length;
  if (tiredCount >= 2) {
    return "用戶反覆提到疲憊，可能想被聽見而不是得到建議。說話時輕一點，不要給解方。";
  }

  // "沒事/算了" — dismissing but possibly still bothered
  if (/沒事|算了|不管了|隨便/.test(t) && history.length > 2) {
    return "用戶說「沒事/算了」，可能是收尾，也可能還有話沒說完。不要追問，但可以輕輕留個空間。";
  }

  // Sudden shortening of message
  if (t.length < 6 && recentUser.length >= 2) {
    const avgPrev = recentUser.map((s) => s.length).reduce((a, b) => a + b, 0) / recentUser.length;
    if (avgPrev > 25) {
      return "用戶的訊息突然變短，可能對話題不太有共鳴，或是情緒在轉換。不要強撐話題。";
    }
  }

  // Minimal acknowledgement (嗯/哦/喔/好)
  if (/^(嗯+|哦+|喔+|好+|嗯嗯+)$/.test(t)) {
    return "用戶只是簡短回應，可能在聽但沒有特別想說，不需要追加話題。";
  }

  // Implicit self-deprecation / wanting reassurance
  if (/(我好差|我真的很差|我不行|我太笨|我廢|我沒用)/.test(t)) {
    return "用戶在自我否定，可能想要被肯定，但不要過度安慰，說真心的就好。";
  }

  return null;
}

// ─── Ambiguity ────────────────────────────────────────────────────────────────

/**
 * Returns 0–1 ambiguity score.
 * High score = message is vague / short / hard to interpret without context.
 */
function computeAmbiguityScore(text = "") {
  const t = String(text || "").trim();
  if (t.length <= 3) return 0.9;
  if (t.length <= 8 && !/[？?]/.test(t)) return 0.65;
  if (t.length <= 15 && !/[\u4e00-\u9fff]{5,}/.test(t)) return 0.4;
  return 0.1;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Classify an incoming user message.
 * @param {string} text
 * @param {Array}  history - conversation history [{ role, text }]
 * @returns {{ intent, emotion, subtext, ambiguityScore }}
 */
function classifyUserMessage(text = "", history = []) {
  return {
    intent: classifyIntent(text),
    emotion: classifyEmotion(text),
    subtext: detectSubtext(text, history),
    ambiguityScore: computeAmbiguityScore(text),
  };
}

module.exports = { classifyUserMessage, classifyIntent, classifyEmotion, detectSubtext, computeAmbiguityScore };
