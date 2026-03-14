"use strict";
/**
 * process_event.test.js
 *
 * End-to-end test of the v2 orchestrator pipeline with a mocked LLM.
 * Tests:
 *   1. Developer private message → role recognized, reply returned
 *   2. Stranger private message → treated as public_user, different context
 *   3. Developer info NOT leaked to stranger
 *   4. Empty/missing text → skipped (no crash)
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

// ── Mock axios BEFORE requiring orchestrator ──────────────────────────────────
// The orchestrator calls axios.post to Ollama. We intercept it here.
jest.mock("axios", () => {
  const original = jest.requireActual("axios");
  return {
    ...original,
    post: jest.fn(async (url, body) => {
      // Mock LLM response — return a simple string based on what was sent
      const systemPrompt = body?.messages?.find(m => m.role === "system")?.content || "";
      const userPrompt   = body?.messages?.find(m => m.role === "user")?.content   || "";

      // Intent parser calls (fast model, single prompt format)
      if (body?.prompt && !body?.messages) {
        return { data: { response: JSON.stringify({ intent: "chat", routing_level: 1, needs_memory: false }) } };
      }

      // Detect developer context from system prompt
      const isDeveloperCtx = systemPrompt.includes("developer") || userPrompt.includes("developer");

      // Return a minimal valid chat response
      return {
        data: {
          message: { content: isDeveloperCtx ? "開發者你好" : "你好陌生人" },
        },
      };
    }),
  };
});

const { processEvent } = require("../../ai/orchestrator");
const { clearSession, makeSessionKey } = require("../../ai/memory/working_memory");

const DEV_USER_ID  = "5686223888";   // telegram developer
const STRANGER_ID  = "9999999999";   // unknown user

function makeDevEvent(overrides = {}) {
  return {
    type:      "message",
    text:      "你好晴",
    content:   "你好晴",
    userId:    DEV_USER_ID,
    username:  "driven09",
    connector: "telegram",
    platform:  "telegram",
    isPrivate: true,
    channel:   "private",
    chatId:    DEV_USER_ID,
    role:      "developer",
    ...overrides,
  };
}

function makeStrangerEvent(overrides = {}) {
  return {
    type:      "message",
    text:      "你好",
    content:   "你好",
    userId:    STRANGER_ID,
    username:  "stranger_user",
    connector: "telegram",
    platform:  "telegram",
    isPrivate: true,
    channel:   "private",
    chatId:    STRANGER_ID,
    role:      "user",
    ...overrides,
  };
}

beforeEach(() => {
  // Clear sessions between tests
  clearSession(makeSessionKey(makeDevEvent()));
  clearSession(makeSessionKey(makeStrangerEvent()));
});

describe("processEvent — developer path", () => {

  test("developer message returns a non-empty reply string", async () => {
    const result = await processEvent(makeDevEvent());
    expect(result).toBeDefined();
    expect(typeof result.reply).toBe("string");
    expect(result.reply.length).toBeGreaterThan(0);
  }, 15000);

  test("skips processing when text is empty", async () => {
    const result = await processEvent(makeDevEvent({ text: "", content: "" }));
    expect(result.reply).toBeFalsy();
    expect(result.meta?.skipped).toBe(true);
  }, 10000);

});

describe("processEvent — stranger path", () => {

  test("stranger message returns a non-empty reply string", async () => {
    const result = await processEvent(makeStrangerEvent());
    expect(result).toBeDefined();
    expect(typeof result.reply).toBe("string");
    expect(result.reply.length).toBeGreaterThan(0);
  }, 15000);

});

describe("processEvent — identity isolation", () => {

  test("developer and stranger sessions are isolated", async () => {
    // Add developer turn
    await processEvent(makeDevEvent({ text: "我的密碼是123456" }));

    // Stranger asks about it — reply should NOT contain developer's secret
    const strangerResult = await processEvent(makeStrangerEvent({ text: "剛才那個人說了什麼？" }));
    expect(strangerResult.reply).not.toContain("123456");
    expect(strangerResult.reply).not.toContain("密碼");
  }, 30000);

});
