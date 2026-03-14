"use strict";
/**
 * identity_mapping.test.js
 *
 * Tests cross-platform identity resolution.
 * Covers the exact bug where discord:399113908058849281 resolved to
 * global_237 instead of global_developer.
 *
 * No LLM calls — pure data logic.
 */

const path = require("path");
// Load env so MAP_PATH resolves correctly
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const { resolveStoredGlobalKey, getOrCreateGlobalUserKey } = require("../../ai/global_identity_map");

const DISCORD_OWNER_ID = "399113908058849281";
const TG_OWNER_ID      = "5686223888";

describe("Cross-platform identity mapping", () => {

  test("Telegram developer ID resolves to global_developer", () => {
    const key = resolveStoredGlobalKey(TG_OWNER_ID);
    expect(key).toBe("global_developer");
  });

  test("Discord owner ID resolves to global_developer (not global_237)", () => {
    const key = resolveStoredGlobalKey(DISCORD_OWNER_ID);
    expect(key).toBe("global_developer");
  });

  test("getOrCreateGlobalUserKey with discord platform resolves to global_developer", () => {
    const key = getOrCreateGlobalUserKey({
      platform: "discord",
      userId:   DISCORD_OWNER_ID,
      username: "driven09",
    });
    expect(key).toBe("global_developer");
  });

  test("getOrCreateGlobalUserKey with unknown platform resolves to global_developer", () => {
    // This is what orchestrator calls when no platform is in the event
    const key = getOrCreateGlobalUserKey({
      platform: "unknown",
      userId:   DISCORD_OWNER_ID,
    });
    expect(key).toBe("global_developer");
  });

  test("Unknown userId returns a stable global_XXX key (not global_developer)", () => {
    const key = resolveStoredGlobalKey("99999999_totally_fake");
    expect(key).not.toBe("global_developer");
    expect(key).toMatch(/^global_/);
  });

});
