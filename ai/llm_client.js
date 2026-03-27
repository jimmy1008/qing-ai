/**
 * llm_client.js — Multi-model Ollama client
 *
 * generate()       → main model (14b) for full replies
 * generateFast()   → fast model (3b) for repair, classification, post eval
 * generateStream() → main model (14b), streamed token-by-token
 *
 * All calls include a timeout and automatic fallback on failure.
 */

const axios = require("axios");
const { enqueueLLM } = require("./llm_queue");

const ENDPOINT = process.env.OLLAMA_ENDPOINT || "http://localhost:11434/api/generate";
const MAIN_MODEL = process.env.LLM_MODEL || "qwen2.5:14b";
const FAST_MODEL = process.env.LLM_FAST_MODEL || "qwen2.5:3b";
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 90000);
const MAIN_TIMEOUT_MS = Number(process.env.LLM_MAIN_TIMEOUT_MS || TIMEOUT_MS);
const FAST_TIMEOUT_MS = Number(process.env.LLM_FAST_TIMEOUT_MS || Math.min(TIMEOUT_MS, 30000));
const LLM_KEEP_ALIVE = process.env.LLM_KEEP_ALIVE || "1h";

// ── Fallback: OpenAI-compatible API (when Ollama is unreachable) ──────────────
// Set OLLAMA_FALLBACK_URL and OLLAMA_FALLBACK_API_KEY in .env to enable.
// e.g. OLLAMA_FALLBACK_URL=https://api.openai.com/v1
//      OLLAMA_FALLBACK_API_KEY=sk-...
//      OLLAMA_FALLBACK_MODEL=gpt-4o-mini
const FALLBACK_URL   = process.env.OLLAMA_FALLBACK_URL   || "";
const FALLBACK_KEY   = process.env.OLLAMA_FALLBACK_API_KEY || "";
const FALLBACK_MODEL = process.env.OLLAMA_FALLBACK_MODEL || "gpt-4o-mini";

function isOllamaDown(err) {
  return err?.code === "ECONNREFUSED" || err?.code === "ECONNRESET" ||
         err?.message?.includes("ECONNREFUSED") || err?.message?.includes("connect");
}

async function callFallback(system, prompt, timeoutMs = MAIN_TIMEOUT_MS) {
  if (!FALLBACK_URL || !FALLBACK_KEY) return "";
  try {
    const resp = await axios.post(
      `${FALLBACK_URL}/chat/completions`,
      {
        model: FALLBACK_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user",   content: prompt  },
        ],
        temperature: 0.75,
        max_tokens:  512,
      },
      {
        timeout: timeoutMs,
        headers: {
          "Authorization": `Bearer ${FALLBACK_KEY}`,
          "Content-Type":  "application/json",
        },
      }
    );
    const text = resp.data?.choices?.[0]?.message?.content || "";
    console.warn("[LLM] used fallback provider:", FALLBACK_URL);
    return String(text).trim();
  } catch (fallbackErr) {
    console.error("[LLM] fallback also failed:", fallbackErr.message);
    return "";
  }
}

// priority 1 = conversation (default), 3 = background tasks
// modelId: alias ("main"|"fast"|"background") — routes to the correct per-model queue
async function callOllama(model, body, timeoutMs = TIMEOUT_MS, priority = 1, modelId = "main") {
  const resp = await enqueueLLM(() => axios.post(ENDPOINT, body, {
    timeout: timeoutMs,
    headers: { "Content-Type": "application/json" },
  }), priority, modelId);
  const raw = resp.data?.response || "";
  // Strip qwen3 thinking tags if they leak into the response
  return raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function buildBody(model, system, prompt, options = {}, stream = false, keepAlive = LLM_KEEP_ALIVE) {
  return {
    model,
    system,
    prompt,
    stream,
    keep_alive: keepAlive,
    // think: false disables qwen3 chain-of-thought output (no-op for other models)
    think: false,
    options: {
      temperature: 0.75,
      top_p: 0.9,
      repeat_penalty: 1.12,
      ...options,
    },
  };
}

function createMultiModelClient() {
  return {
    // Main model — used for primary reply generation
    // priority: 1 = conversation (default), 3 = background/proactive
    async generate({ system, prompt, options = {}, timeoutMs = MAIN_TIMEOUT_MS, keepAlive = LLM_KEEP_ALIVE, priority = 1 }) {
      try {
        const raw = await callOllama(
          MAIN_MODEL,
          buildBody(MAIN_MODEL, system, prompt, options, false, keepAlive),
          timeoutMs,
          priority,
          "main",
        );
        return String(raw).trim();
      } catch (err) {
        if (err.code === "ECONNABORTED" || err.message?.includes("timeout")) {
          console.error("[LLM] main model timeout, returning empty");
          return "";
        }
        if (isOllamaDown(err)) return callFallback(system, prompt, timeoutMs);
        throw err;
      }
    },

    // Fast model — used for repair, artifact retry, reflex, post evaluation
    async generateFast({ system, prompt, options = {}, timeoutMs = FAST_TIMEOUT_MS, keepAlive = LLM_KEEP_ALIVE, priority = 1 }) {
      try {
        const raw = await callOllama(
          FAST_MODEL,
          buildBody(FAST_MODEL, system, prompt, { temperature: 0.5, top_p: 0.85, ...options }, false, keepAlive),
          timeoutMs,
          priority,
          "fast",
        );
        return String(raw).trim();
      } catch (err) {
        if (err.code === "ECONNABORTED" || err.message?.includes("timeout")) {
          console.error("[LLM] fast model timeout, returning empty");
          return "";
        }
        if (isOllamaDown(err)) return callFallback(system, prompt, timeoutMs);
        throw err;
      }
    },

    // Streaming — main model only, yields tokens one by one
    // Queued at priority 1 (conversation) before the stream starts
    async *generateStream({ system, prompt, options = {}, timeoutMs = MAIN_TIMEOUT_MS, keepAlive = LLM_KEEP_ALIVE }) {
      const resp = await enqueueLLM(() => axios.post(
        ENDPOINT,
        buildBody(MAIN_MODEL, system, prompt, options, true, keepAlive),
        { responseType: "stream", timeout: timeoutMs },
      ), 1, "main");

      let pending = "";
      for await (const chunk of resp.data) {
        pending += chunk.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.response) yield parsed.response;
            if (parsed.done) return;
          } catch { /* skip malformed */ }
        }
      }
    },
  };
}

module.exports = { createMultiModelClient, MAIN_MODEL, FAST_MODEL };
