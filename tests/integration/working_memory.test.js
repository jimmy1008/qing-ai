"use strict";
/**
 * working_memory.test.js
 *
 * Tests that session keys are correctly isolated by platform + channel + user.
 * Ensures Discord private / Telegram private / Telegram group never share sessions.
 *
 * No LLM calls — pure data logic.
 */

const { makeSessionKey, getSession, addTurn, clearSession } = require("../../ai/memory/working_memory");

function makeEvent(overrides = {}) {
  return {
    connector: "telegram",
    isPrivate: true,
    channel:   "private",
    userId:    "5686223888",
    chatId:    "5686223888",
    ...overrides,
  };
}

describe("Session key generation", () => {

  test("Telegram private chat key", () => {
    const key = makeSessionKey(makeEvent({ connector: "telegram", isPrivate: true, userId: "123" }));
    expect(key).toBe("telegram:private:123");
  });

  test("Telegram group chat key (uses chatId, not userId)", () => {
    const key = makeSessionKey(makeEvent({
      connector: "telegram",
      isPrivate: false,
      channel:   "group",
      chatId:    "-1001234567890",
    }));
    expect(key).toBe("telegram:group:-1001234567890");
  });

  test("Discord private chat key", () => {
    const key = makeSessionKey(makeEvent({
      connector: "discord",
      isPrivate: true,
      userId:    "399113908058849281",
    }));
    expect(key).toBe("discord:private:399113908058849281");
  });

  test("Discord and Telegram sessions for the same owner are DIFFERENT keys", () => {
    const tgKey = makeSessionKey(makeEvent({ connector: "telegram", isPrivate: true, userId: "5686223888" }));
    const dcKey = makeSessionKey(makeEvent({ connector: "discord",  isPrivate: true, userId: "399113908058849281" }));
    expect(tgKey).not.toBe(dcKey);
  });

  test("Two different users on Telegram have DIFFERENT sessions", () => {
    const key1 = makeSessionKey(makeEvent({ userId: "111" }));
    const key2 = makeSessionKey(makeEvent({ userId: "222" }));
    expect(key1).not.toBe(key2);
  });

});

describe("Session data isolation", () => {
  const KEY_A = "test:private:user_a";
  const KEY_B = "test:private:user_b";

  beforeEach(() => {
    clearSession(KEY_A);
    clearSession(KEY_B);
  });

  afterEach(() => {
    clearSession(KEY_A);
    clearSession(KEY_B);
  });

  test("addTurn writes to correct session", () => {
    addTurn(KEY_A, "u1", "Alice", "hello", "hi alice");
    const sessionA = getSession(KEY_A);
    const sessionB = getSession(KEY_B);
    expect(sessionA.length).toBe(2); // user + assistant
    expect(sessionB.length).toBe(0); // untouched
  });

  test("Session content is correct after addTurn", () => {
    addTurn(KEY_A, "u1", "Alice", "user message", "bot reply");
    const session = getSession(KEY_A);
    expect(session[0].role).toBe("user");
    expect(session[0].text).toBe("user message");
    expect(session[1].role).toBe("assistant");
    expect(session[1].text).toBe("bot reply");
  });

  test("clearSession empties a session", () => {
    addTurn(KEY_A, "u1", "Alice", "hello", "hi");
    clearSession(KEY_A);
    expect(getSession(KEY_A).length).toBe(0);
  });

  test("Sessions do NOT bleed between users", () => {
    addTurn(KEY_A, "u1", "Alice", "secret from alice", "ok alice");
    addTurn(KEY_B, "u2", "Bob",   "secret from bob",   "ok bob");

    const sessionA = getSession(KEY_A);
    const sessionB = getSession(KEY_B);

    const aTexts = sessionA.map(t => t.text).join(" ");
    const bTexts = sessionB.map(t => t.text).join(" ");

    expect(aTexts).not.toContain("bob");
    expect(bTexts).not.toContain("alice");
  });

});
