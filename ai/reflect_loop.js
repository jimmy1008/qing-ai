/**
 * reflect_loop.js
 * Post-generation self-evaluation and targeted rewrite.
 *
 * Flow:
 *   draft
 *     → critique (rules, fast)
 *     → if issues: LLM rewrite (targeted repair prompt)
 *     → return { text, reflected, rewrote, issues, pass }
 */

const { judgeConsistency, buildConsistencyRepairPrompt } = require("./consistency_judge");

/**
 * Evaluate and optionally rewrite a generated draft.
 *
 * @param {string} draft            - The LLM-generated text to evaluate
 * @param {object} opts
 * @param {string} opts.userInput   - Original user message (for repair context)
 * @param {object} opts.context     - Pipeline context (personaModeKey, channel, etc.)
 * @param {object} opts.ollamaClient - Ollama client instance (null = rule-only mode)
 * @param {string} opts.systemPrompt - System prompt to use for rewrite
 *
 * @returns {{ text, reflected, rewrote, issues, rewriteIssues, pass, error }}
 */
async function reflectAndRefine(draft, {
  userInput = "",
  context = {},
  ollamaClient = null,
  systemPrompt = "",
} = {}) {
  const normalized = String(draft || "").trim();
  if (!normalized) {
    return { text: draft, reflected: false, rewrote: false, issues: ["empty"], pass: false };
  }

  // Phase 1: Rule-based critique (always runs, no LLM cost)
  const critique = judgeConsistency(normalized, context);

  if (critique.ok) {
    return { text: normalized, reflected: true, rewrote: false, issues: [], pass: true };
  }

  // Phase 2: LLM rewrite (only if client available and issues detected)
  if (!ollamaClient) {
    return {
      text: normalized,
      reflected: true,
      rewrote: false,
      issues: critique.reasons,
      pass: false,
    };
  }

  const repairPrompt = buildConsistencyRepairPrompt(userInput, normalized, critique.reasons);

  try {
    const raw = await ollamaClient.generate({
      system: systemPrompt,
      prompt: repairPrompt,
      options: { temperature: 0.6, top_p: 0.85 },
    });

    const rewritten = String(raw || "").trim();
    if (!rewritten) {
      return {
        text: normalized,
        reflected: true,
        rewrote: false,
        issues: critique.reasons,
        pass: false,
        error: "rewrite_empty",
      };
    }

    // Verify rewrite passes rules
    const recheck = judgeConsistency(rewritten, context);
    return {
      text: rewritten,
      reflected: true,
      rewrote: true,
      issues: critique.reasons,
      rewriteIssues: recheck.reasons,
      pass: recheck.ok,
    };
  } catch (err) {
    return {
      text: normalized,
      reflected: true,
      rewrote: false,
      issues: critique.reasons,
      pass: false,
      error: err.message,
    };
  }
}

/**
 * Synchronous rule-only critique (no rewrite, no LLM).
 * Use when latency budget is zero.
 */
function critiqueOnly(draft, context = {}) {
  return judgeConsistency(String(draft || "").trim(), context);
}

module.exports = { reflectAndRefine, critiqueOnly };
