"use strict";

function isDirectQuestion(text = "") {
  return /[?？]$/.test(String(text || "").trim());
}

function containsBotNameQuestion(text = "", botUsername = "") {
  const normalizedBot = String(botUsername || "").replace(/^@/, "").trim();
  if (!normalizedBot) return false;
  const input = String(text || "");
  return input.toLowerCase().includes(normalizedBot.toLowerCase()) && isDirectQuestion(input);
}

function detectMention(event = {}, botUsername = "") {
  const text = String(event.text || event.content || "").trim();
  const normalizedBot = String(botUsername || "").replace(/^@/, "");
  const mentionByUsername = normalizedBot
    ? text.includes(`@${normalizedBot}`)
    : false;

  const replyToBot = Boolean(
    event.replyToBot
    || event.isReplyToBot
    || event.reply_to_message?.from?.username === normalizedBot
  );

  const botNameQuestion = containsBotNameQuestion(text, botUsername);
  const isDirectMention = Boolean(mentionByUsername || replyToBot || botNameQuestion);

  return {
    mentionDetected: isDirectMention,
    isDirectMention,
    mentionReason: mentionByUsername
      ? "username_mention"
      : replyToBot
      ? "reply_to_bot"
      : botNameQuestion
      ? "bot_name_question"
      : "none",
  };
}

module.exports = {
  detectMention,
};
