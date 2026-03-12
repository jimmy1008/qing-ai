function shouldEngage(event, personaState = {}) {
  if (!event || !event.content) {
    return { engage: false, reason: "no_content", confidence: 1.0 };
  }

  const text = String(event.content || "").trim();
  const channel = event.channel || "public";
  const isGroup = channel === "group";
  const hostilePatterns = ["\u5783\u573e", "\u721b", "\u6efe", "\u53bb\u6b7b", "\u4f60\u4e0d\u884c"];

  if (channel === "private") {
    if (hostilePatterns.some((pattern) => text.includes(pattern))) {
      return { engage: false, reason: "hostile_content", confidence: 0.9 };
    }
    return { engage: true, reason: "private_direct_chat", confidence: 1.0 };
  }

  if (hostilePatterns.some((pattern) => text.includes(pattern))) {
    return { engage: false, reason: "hostile_content", confidence: 0.9 };
  }

  if (text.length < 3) {
    return { engage: false, reason: "low_signal", confidence: 0.8 };
  }

  const questionDetected =
    text.includes("\u70ba\u4ec0\u9ebc")
    || text.includes("\u600e\u9ebc")
    || text.includes("?")
    || text.includes("？")
    || text.startsWith("\u4f60\u9084\u8a18\u5f97")
    || text.startsWith("\u8a18\u5f97")
    || text.startsWith("\u662f\u4e0d\u662f")
    || text.startsWith("\u80fd\u4e0d\u80fd");

  if (questionDetected) {
    if (isGroup && !event.isDirectMention && !event.mentionDetected) {
      return { engage: false, reason: "group_question_downgraded", confidence: 0.5 };
    }
    return { engage: true, reason: "question_detected", confidence: 0.8 };
  }

  if (event.type === "mention" || event.isDirectMention || event.mentionDetected) {
    return { engage: true, reason: "direct_mention", confidence: 1.0 };
  }

  return { engage: false, reason: "default_ignore", confidence: 0.6 };
}

module.exports = { shouldEngage };
