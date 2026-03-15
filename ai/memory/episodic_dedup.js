"use strict";

const { createMultiModelClient } = require("../llm_client");

const client = createMultiModelClient();
const DEFAULT_THRESHOLD = Number(process.env.SEMANTIC_DEDUP_THRESHOLD || 0.86);

function parseJson(raw) {
  const text = String(raw || "");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function semanticDuplicateCheck(newSummary, candidates = [], options = {}) {
  const threshold = Number(options.threshold || DEFAULT_THRESHOLD);
  const top = candidates.slice(0, 8).map((c) => ({ id: c.id, summary: c.summary }));
  if (!top.length) return { duplicate: false, confidence: 0, reason: "no_candidates" };

  const system = [
    "You are a semantic deduplication judge for short memory summaries.",
    "Return JSON only.",
    "Output format: {\"match_id\":\"id_or_null\",\"same\":true|false,\"confidence\":0..1,\"reason\":\"short\"}",
    "same=true only when both summaries are materially the same event/fact.",
  ].join("\n");

  const prompt = JSON.stringify({ new_summary: newSummary, candidates: top });

  try {
    const raw = await client.generateFast({ system, prompt, timeoutMs: 12000, priority: 2 });
    const out = parseJson(raw);
    if (!out) return { duplicate: false, confidence: 0, reason: "unparseable" };

    const confidence = Math.max(0, Math.min(1, Number(out.confidence || 0)));
    const same = Boolean(out.same) && confidence >= threshold;
    return {
      duplicate: same,
      matchedId: same ? String(out.match_id || "") : null,
      confidence,
      reason: String(out.reason || "semantic_judge"),
    };
  } catch (err) {
    return { duplicate: false, confidence: 0, reason: err.message || "semantic_error" };
  }
}

module.exports = { semanticDuplicateCheck };
