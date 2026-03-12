/**
 * event_graph.js
 * Lightweight event workflow graph — explicit, traceable, composable.
 *
 * Each node is a named async handler. Edges define routing between nodes.
 * State is passed through the graph and a trace is recorded per traversal.
 *
 * Design principles:
 *   - Does NOT replace the scheduler or planner — runs within processNextAction()
 *   - Each node returns { next: "NODE_NAME", state } or { done: true, state }
 *   - Retry: nodes can throw; the graph catches and retries up to maxRetries
 *   - Trace: full audit trail per event (node, duration, result)
 */

class EventGraph {
  constructor({ maxRetries = 2, maxNodes = 30, nodeTimeoutMs = 5000 } = {}) {
    this._nodes = new Map();   // name → handler(state) → { next, state } | { done, state }
    this._edges = new Map();   // fromNode → [{ to, condition }]
    this._maxRetries = maxRetries;
    this._maxNodes = maxNodes;       // guard against infinite loops
    this._nodeTimeoutMs = nodeTimeoutMs; // max ms per node handler
  }

  /**
   * Register a node handler.
   * @param {string}   name     - unique node name (e.g. "CLASSIFY")
   * @param {Function} handler  - async (state) => { next: string, state } | { done: true, state }
   */
  node(name, handler) {
    if (typeof handler !== "function") throw new Error(`Node handler for "${name}" must be a function`);
    this._nodes.set(name, handler);
    return this; // chainable
  }

  /**
   * Register a directed edge (optional — nodes can also return next directly).
   * @param {string}   from      - source node name
   * @param {string}   to        - target node name
   * @param {Function} condition - optional (state) => bool; null = unconditional
   */
  edge(from, to, condition = null) {
    if (!this._edges.has(from)) this._edges.set(from, []);
    this._edges.get(from).push({ to, condition });
    return this;
  }

  /**
   * Run the graph starting from startNode.
   * @param {object} initialState  - initial state object (merged with event)
   * @param {string} startNode     - entry node name (default: "RECEIVE")
   * @returns {Promise<{ finalState, trace, error }>}
   */
  async run(initialState = {}, startNode = "RECEIVE") {
    const trace = [];
    let state = { ...initialState };
    let currentNode = startNode;
    let steps = 0;

    while (currentNode && steps < this._maxNodes) {
      steps++;
      const handler = this._nodes.get(currentNode);

      if (!handler) {
        const err = new Error(`EventGraph: unknown node "${currentNode}"`);
        trace.push({ node: currentNode, error: err.message, ts: Date.now() });
        return { finalState: state, trace, error: err };
      }

      const nodeTrace = { node: currentNode, ts: Date.now(), durationMs: 0, result: null };
      const start = Date.now();
      let attempts = 0;
      let result = null;

      const timeoutMs = this._nodeTimeoutMs;
      while (attempts <= this._maxRetries) {
        try {
          const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`node_timeout:${currentNode}`)), timeoutMs),
          );
          result = await Promise.race([handler(state), timeout]);
          break;
        } catch (err) {
          attempts++;
          nodeTrace.error = err.message;
          if (attempts > this._maxRetries) {
            nodeTrace.durationMs = Date.now() - start;
            trace.push(nodeTrace);
            return { finalState: state, trace, error: err };
          }
        }
      }

      nodeTrace.durationMs = Date.now() - start;
      nodeTrace.result = result;
      trace.push(nodeTrace);

      // Merge returned state
      if (result && result.state) {
        state = { ...state, ...result.state };
      }

      // Terminal condition
      if (result && result.done) break;

      // Determine next node
      let nextNode = result?.next || null;

      // If no explicit next from handler, check registered edges
      if (!nextNode) {
        const edges = this._edges.get(currentNode) || [];
        for (const edge of edges) {
          if (!edge.condition || edge.condition(state)) {
            nextNode = edge.to;
            break;
          }
        }
      }

      currentNode = nextNode;
    }

    if (steps >= this._maxNodes) {
      const err = new Error(`EventGraph: max node limit (${this._maxNodes}) exceeded`);
      return { finalState: state, trace, error: err };
    }

    return { finalState: state, trace, error: null };
  }
}

/**
 * Build the default SocialAI workflow graph.
 *
 * Nodes: RECEIVE → CLASSIFY → PLAN → MODERATE → DONE
 *
 * Each node is a thin wrapper that delegates to existing modules —
 * the graph provides traceability and state management.
 */
function buildDefaultWorkflow() {
  const graph = new EventGraph();

  // RECEIVE: validate and normalize the incoming event
  graph.node("RECEIVE", async (state) => {
    const event = state.event || {};
    return {
      next: "CLASSIFY",
      state: {
        receivedAt: Date.now(),
        platform: event.platform || event.connector || "unknown",
        eventType: event.type || "unknown",
      },
    };
  });

  // CLASSIFY: map event to intent
  graph.node("CLASSIFY", async (state) => {
    const { event = {} } = state;
    const type = String(event.type || "").toUpperCase();

    let intent = "none";
    if (type === "NEW_DM" || event.channel === "private") intent = "reply_dm";
    else if (type === "NEW_COMMENT_ON_OWN_POST") intent = "reply_self_post";
    else if (type === "NEW_COMMENT_ON_EXTERNAL_POST") intent = "reply_external";
    else if (type === "NEW_POST_IN_FEED") intent = "feed";
    else if (type === "MENTION") intent = "reply_mention";

    return {
      next: intent === "none" ? "DONE" : "PLAN",
      state: { intent, classifiedAt: Date.now() },
    };
  });

  // PLAN: delegate to action planner (existing logic)
  graph.node("PLAN", async (state) => {
    return {
      next: "MODERATE",
      state: { plannedAt: Date.now() },
    };
  });

  // MODERATE: check if action needs human approval
  graph.node("MODERATE", async (state) => {
    const requiresApproval = state.platform === "threads";
    return {
      done: true,
      state: {
        requiresApproval,
        moderatedAt: Date.now(),
        disposition: requiresApproval ? "queued" : "auto",
      },
    };
  });

  // DONE: terminal no-op
  graph.node("DONE", async (state) => {
    return { done: true, state: { completedAt: Date.now() } };
  });

  return graph;
}

// Singleton default workflow
const defaultWorkflow = buildDefaultWorkflow();

module.exports = { EventGraph, buildDefaultWorkflow, defaultWorkflow };
