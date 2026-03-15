"use strict";

const { randomUUID } = require("crypto");

function summarizeOverflowEpisodes(episodes = [], overflowCount = 0, tier = "normal") {
  if (!overflowCount || episodes.length === 0) return null;

  const source = [...episodes]
    .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0))
    .slice(0, overflowCount);

  if (!source.length) return null;

  const snippets = source
    .map((ep) => String(ep.summary || "").trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((s) => s.slice(0, 24));

  const summary = snippets.length
    ? `摘要(${tier}): ` + snippets.join(" / ")
    : `摘要(${tier}): ${source.length} 則歷史事件彙整`;

  return {
    id: randomUUID(),
    user_id: source[0].user_id,
    event_type: "SUMMARY",
    summary,
    importance: tier === "milestone" ? 0.82 : 0.55,
    emotional_tag: null,
    embedding: null,
    created_at: Date.now(),
    summarized_count: source.length,
    tier,
  };
}

module.exports = { summarizeOverflowEpisodes };
