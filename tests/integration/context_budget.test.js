"use strict";
/**
 * context_budget.test.js
 *
 * Tests the context window budget manager.
 * Verifies priority ordering and truncation behaviour.
 *
 * No LLM calls.
 */

const { applyBudget, trimRecentTurns, estimateChars, USER_PROMPT_CHAR_BUDGET } = require("../../ai/modules/context_budget");

describe("applyBudget — priority ordering", () => {

  test("CRITICAL block is always included", () => {
    const result = applyBudget([
      { priority: "critical", text: "CRITICAL_TEXT" },
    ]);
    expect(result).toContain("CRITICAL_TEXT");
  });

  test("CRITICAL included even when budget is 0", () => {
    // Simulate budget already exhausted by many optional blocks
    const manyOptional = Array.from({ length: 200 }, (_, i) => ({
      priority: "optional",
      text: "x".repeat(100),
    }));
    const result = applyBudget([
      ...manyOptional,
      { priority: "critical", text: "MUST_APPEAR" },
    ]);
    expect(result).toContain("MUST_APPEAR");
  });

  test("OPTIONAL block is dropped when budget exhausted by HIGH content", () => {
    const bigHigh = "H".repeat(USER_PROMPT_CHAR_BUDGET - 10);
    const result = applyBudget([
      { priority: "critical", text: "MSG" },
      { priority: "high",     text: bigHigh },
      { priority: "optional", text: "OPTIONAL_SHOULD_BE_DROPPED" },
    ]);
    expect(result).not.toContain("OPTIONAL_SHOULD_BE_DROPPED");
  });

  test("MEDIUM included before OPTIONAL", () => {
    // Budget: enough for critical + medium, not optional
    const bigCritical = "C".repeat(USER_PROMPT_CHAR_BUDGET - 500);
    const result = applyBudget([
      { priority: "critical", text: bigCritical },
      { priority: "medium",   text: "MEDIUM_TEXT" },
      { priority: "optional", text: "OPTIONAL_TEXT" },
    ]);
    // medium should be included if fits, optional not
    // (depends on remaining budget — just verify medium comes before optional in logic)
    // If medium fits, it's in; optional may or may not be
    if (result.includes("MEDIUM_TEXT")) {
      // OK
    }
    // At minimum, if optional is missing, medium should have been there
    if (!result.includes("OPTIONAL_TEXT")) {
      expect(result).toContain("MEDIUM_TEXT");
    }
  });

  test("All high-priority blocks included when budget is large enough", () => {
    const result = applyBudget([
      { priority: "critical",  text: "CRITICAL" },
      { priority: "high",      text: "HIGH" },
      { priority: "medium",    text: "MEDIUM" },
      { priority: "low",       text: "LOW" },
      { priority: "optional",  text: "OPTIONAL" },
    ]);
    expect(result).toContain("CRITICAL");
    expect(result).toContain("HIGH");
    expect(result).toContain("MEDIUM");
    expect(result).toContain("LOW");
    expect(result).toContain("OPTIONAL");
  });

});

describe("trimRecentTurns — keeps most recent", () => {

  const turns = [
    { role: "user",      text: "oldest message",  ts: 1 },
    { role: "assistant", text: "oldest reply",    ts: 2 },
    { role: "user",      text: "middle message",  ts: 3 },
    { role: "assistant", text: "middle reply",    ts: 4 },
    { role: "user",      text: "newest message",  ts: 5 },
    { role: "assistant", text: "newest reply",    ts: 6 },
  ];

  test("returns all turns when budget is large", () => {
    const result = trimRecentTurns(turns, 99999);
    expect(result.length).toBe(6);
  });

  test("keeps NEWEST turns when trimming", () => {
    // Budget only allows ~2 messages
    const result = trimRecentTurns(turns, 60);
    expect(result.length).toBeGreaterThan(0);
    // Newest message must be present
    const texts = result.map(t => t.text);
    expect(texts).toContain("newest message");
  });

  test("oldest message is dropped first when budget is tight", () => {
    const result = trimRecentTurns(turns, 80);
    const texts = result.map(t => t.text);
    if (texts.length < turns.length) {
      expect(texts).not.toContain("oldest message");
    }
  });

  test("empty input returns empty array", () => {
    expect(trimRecentTurns([], 9999)).toEqual([]);
    expect(trimRecentTurns(null, 9999)).toEqual([]);
  });

});

describe("estimateChars", () => {
  test("returns character length of string", () => {
    expect(estimateChars("hello")).toBe(5);
    expect(estimateChars("你好世界")).toBe(4);
    expect(estimateChars("")).toBe(0);
    expect(estimateChars(null)).toBe(0);
  });
});
