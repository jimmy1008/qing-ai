"use strict";

function isQuestion(text = "") {
  return /[?？]$/.test(String(text || "").trim());
}

function isShortAcknowledgement(text = "") {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return true;
  return /^(嗯|恩|ok|okay|好|喔|哦|噢|\.|。|收到|了解|好喔|好喔。)$/.test(t);
}

function computeConversationTendency(context = {}) {
  const msg = String(context.currentMessage || "").trim();
  const window = Array.isArray(context.conversationWindow) ? context.conversationWindow : [];
  const assistantReplies = window.filter((m) => m && m.role === "assistant");
  const lastTwoAssistant = assistantReplies.slice(-2);

  // Guard against question-loop bot.
  if (
    lastTwoAssistant.length === 2
    && isQuestion(lastTwoAssistant[0].text)
    && isQuestion(lastTwoAssistant[1].text)
  ) {
    return "observe";
  }

  // Silence tolerance for minimal user signals.
  if (isShortAcknowledgement(msg) || msg.length < 3) return "silence";

  // Lightweight tendency bias only (not hard planning).
  if (/[?？]/.test(msg)) return "respond";
  if (/不同意|不太認同|太武斷|敷衍|沒抓到重點|不對|不是這樣/.test(msg)) return "challenge";
  if (/先這樣|晚點|等等|不聊了|先停|掰|bye/i.test(msg)) return "close";
  if (msg.length > 80) return "observe";
  if (/你覺得|怎麼看|能不能|可不可以|幫我/.test(msg)) return "ask";
  return "respond";
}

module.exports = {
  computeConversationTendency,
};

