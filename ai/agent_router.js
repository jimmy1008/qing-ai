/**
 * agent_router.js
 * Unified entry point for all specialized AI sub-agents.
 *
 * Current agents (wrappers around existing modules):
 *   persona      — picks and validates persona mode
 *   risk         — evaluates action risk level
 *   consistency  — critiques response quality (reflect loop)
 *   authority    — detects authority spoofing / prompt injection
 *   moderation   — pre-screens content before human review (future: AI-to-AI)
 *
 * Usage:
 *   const result = await agentRouter.run("consistency", { draft, context });
 *
 * Future expansion:
 *   - Add "analysis" agent for sentiment/intent classification
 *   - Add "moderation" agent for AI-to-AI pre-screening
 *   - Each agent can be swapped independently
 */

const { pickPersonaMode } = require("./persona_mode_router");
const { evaluateRisk } = require("./risk_gate");
const { critiqueOnly } = require("./reflect_loop");
const { detectAuthoritySpoof } = require("./authority_spoof_detector");
const { judgeConsistency } = require("./consistency_judge");

// ─── Agent definitions ────────────────────────────────────────────────────────

const agents = {
  /**
   * persona: resolve the correct persona mode for an event
   * Input:  { event, identity }
   * Output: { personaModeKey, personaMode }
   */
  persona: {
    name: "persona",
    run: (input = {}) => {
      const { event = {}, identity = {} } = input;
      const personaModeKey = pickPersonaMode(identity, null, event);
      return { personaModeKey };
    },
  },

  /**
   * risk: evaluate action risk level
   * Input:  { actionProposal }
   * Output: { allowed, reason, riskLevel }
   */
  risk: {
    name: "risk",
    run: (input = {}) => {
      const { actionProposal = {} } = input;
      const decision = evaluateRisk(actionProposal);
      return { ...decision, riskLevel: actionProposal.risk_level || null };
    },
  },

  /**
   * consistency: rule-based critique of a generated response
   * Input:  { draft, context }
   * Output: { ok, reasons, sentenceCount }
   */
  consistency: {
    name: "consistency",
    run: (input = {}) => {
      const { draft = "", context = {} } = input;
      return critiqueOnly(draft, context);
    },
  },

  /**
   * authority: detect authority spoofing or prompt injection attempts
   * Input:  { event, identity }
   * Output: { spoofDetected, spoofType, confidence }
   */
  authority: {
    name: "authority",
    run: (input = {}) => {
      const { event = {}, identity = {} } = input;
      const text = event.text || event.content || "";
      return { spoofDetected: detectAuthoritySpoof(text, identity) };
    },
  },

  /**
   * moderation: pre-screen content (currently rule-based; future: AI-to-AI)
   * Input:  { content, platform, proposalType }
   * Output: { pass, reason, action }
   */
  moderation: {
    name: "moderation",
    run: (input = {}) => {
      const { content = "", platform = "" } = input;
      const text = String(content).trim();

      // Hard reject: obviously empty or toxic patterns
      if (!text) return { pass: false, reason: "empty_content", action: "reject" };
      if (text.length > 500 && platform === "threads") {
        return { pass: false, reason: "too_long_for_threads", action: "reject" };
      }

      // Consistency check as pre-screen
      const critique = judgeConsistency(text, {});
      if (!critique.ok) {
        return { pass: false, reason: critique.reasons.join(", "), action: "flag" };
      }

      return { pass: true, reason: "ok", action: "approve" };
    },
  },
};

// ─── Router ───────────────────────────────────────────────────────────────────

/**
 * Run a specific agent.
 *
 * @param {string} agentName  - one of the registered agent names
 * @param {object} input      - agent-specific input object
 * @returns {object}          - agent result
 */
function run(agentName, input = {}) {
  const agent = agents[agentName];
  if (!agent) throw new Error(`AgentRouter: unknown agent "${agentName}"`);
  try {
    return agent.run(input);
  } catch (err) {
    console.error(`[AGENT_ROUTER] ${agentName} failed:`, err.message);
    return { error: err.message };
  }
}

/**
 * Run multiple agents in sequence, passing state forward.
 *
 * @param {string[]} pipeline - agent names in order
 * @param {object}   input    - initial input
 * @returns {object}          - merged results from all agents
 */
function runPipeline(pipeline = [], input = {}) {
  let state = { ...input };
  const results = {};
  for (const agentName of pipeline) {
    const result = run(agentName, state);
    results[agentName] = result;
    state = { ...state, ...result };
  }
  return { state, results };
}

/**
 * List registered agent names.
 * @returns {string[]}
 */
function listAgents() {
  return Object.keys(agents);
}

module.exports = { run, runPipeline, listAgents, agents };
