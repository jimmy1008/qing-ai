"use strict";

const { createMultiModelClient } = require("./llm_client");

let _client = null;
function getClient() {
  if (!_client) _client = createMultiModelClient();
  return _client;
}

function parseThreadsEvaluation(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) {
    return {
      action: "ignore",
      emotionalResonance: 0,
      preferenceScore: 0,
      reason: "empty_response",
      emotionDetected: "none",
      emotion: "none",
    };
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      action: "ignore",
      emotionalResonance: 0,
      preferenceScore: 0,
      reason: "unparseable_response",
      emotionDetected: "none",
      emotion: "none",
    };
  }

  try {
    const parsed = JSON.parse(match[0]);
    const action = parsed.action === "like" ? "like" : "ignore";
    const emotionalResonance = Math.max(
      0,
      Math.min(1, Number(parsed.emotionalResonance ?? parsed.preferenceScore ?? parsed.confidence) || 0),
    );
    const allowed = ["warm", "lonely", "playful", "comfort", "cute", "curious", "funny", "none"];
    const emotionDetected = allowed.includes(parsed.emotionDetected)
      ? parsed.emotionDetected
      : (allowed.includes(parsed.emotion) ? parsed.emotion : "none");

    return {
      action,
      emotionalResonance,
      preferenceScore: emotionalResonance,
      reason: String(parsed.reason || ""),
      emotionDetected,
      emotion: emotionDetected,
    };
  } catch {
    return {
      action: "ignore",
      emotionalResonance: 0,
      preferenceScore: 0,
      reason: "invalid_json",
      emotionDetected: "none",
      emotion: "none",
    };
  }
}

async function evaluateThreadsPost(text) {
  const content = String(text || "").trim();
  if (!content) {
    return {
      action: "ignore",
      emotionalResonance: 0,
      preferenceScore: 0,
      reason: "empty_post",
      emotionDetected: "none",
      emotion: "none",
    };
  }

  const system = [
    "You are evaluating a Threads post for a social AI with stable, selective taste.",
    "Return JSON only.",
    "Like only when there is clear genuine resonance.",
    "Avoid political debate, hostility, adult/sexual content, and engagement bait.",
    "If uncertain, ignore.",
    'Allowed action: "like" or "ignore".',
    'Allowed emotionDetected: "warm", "lonely", "playful", "comfort", "cute", "curious", "funny", "none".',
    'Format: {"action":"like|ignore","emotionalResonance":0.0,"reason":"short_reason","emotionDetected":"..."}',
  ].join("\n");

  const prompt = `Post:\n${content}\n\nReturn JSON only.`;

  try {
    const raw = await getClient().generateFast({ system, prompt, timeoutMs: 20000, priority: 2 });
    return parseThreadsEvaluation(raw);
  } catch (err) {
    return {
      action: "ignore",
      emotionalResonance: 0,
      preferenceScore: 0,
      reason: err.message || "evaluation_error",
      emotionDetected: "none",
      emotion: "none",
    };
  }
}

async function generateThreadsProactiveComment(postText, impressionCtx = {}) {
  const content = String(postText || "").trim();
  if (!content) return null;

  const { likeCount = 0, impression = "neutral", recentEmotions = [] } = impressionCtx;
  const familiarityNote = impression === "warm"
    ? `You have liked this person's posts ${likeCount} times before.`
    : impression === "curious"
      ? "You have slight prior familiarity with this person."
      : "You do not know this person yet.";

  const recentEmotion = recentEmotions[0] || null;
  const emotionNote = recentEmotion ? `Last resonance feeling: ${recentEmotion}.` : "";

  const system = [
    "You are ´¸´¸, writing one short spontaneous Traditional Chinese comment on a resonant Threads post.",
    "Rules:",
    "- 1 sentence only, max 30 Chinese characters.",
    "- No emoji.",
    "- No generic praise/filler.",
    "- Must react to a concrete detail from the post.",
    "- If no genuine reaction, output exactly SKIP.",
    `${familiarityNote} ${emotionNote}`.trim(),
    "Output comment only.",
  ].join("\n");

  const prompt = `Post:\n${content.slice(0, 200)}\n\nOutput comment or SKIP:`;

  try {
    const raw = await getClient().generateFast({ system, prompt, timeoutMs: 25000, priority: 2 });
    const text = String(raw || "").trim();
    if (!text || /^skip\b/i.test(text)) return null;
    const cleaned = text.replace(/^(comment:|reply:|output:)/i, "").trim();
    return cleaned ? cleaned.slice(0, 60) : null;
  } catch {
    return null;
  }
}

module.exports = {
  evaluateThreadsPost,
  generateThreadsProactiveComment,
};
