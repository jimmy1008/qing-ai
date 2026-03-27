"use strict";
/**
 * llm_queue.js — Per-model priority queues for all Ollama calls.
 *
 * Why per-model: Ollama takes 2-10 s to swap between models. Grouping
 * requests by model eliminates swap thrashing. When OLLAMA_MAX_LOADED_MODELS≥2
 * each model queue can also run concurrently.
 *
 * Model aliases (set in .env):
 *   main       → LLM_MODEL            (default: qwen3:8b)
 *   fast       → LLM_FAST_MODEL       (default: LLM_MODEL)
 *   background → LLM_BACKGROUND_MODEL (default: LLM_MODEL)
 *
 * Usage:
 *   enqueueLLM(fn, 1)              // main model, foreground
 *   enqueueLLM(fn, 3, "background") // background model, low priority
 *   enqueueLLM(fn, 2, "fast")       // fast model, routing priority
 *
 * Priority: 1=conversation, 2=routing/intent, 3=background. Lower = higher.
 */

const _MAIN_MODEL       = process.env.LLM_MODEL            || "qwen3:8b";
const _FAST_MODEL       = process.env.LLM_FAST_MODEL       || _MAIN_MODEL;
const _BACKGROUND_MODEL = process.env.LLM_BACKGROUND_MODEL || _MAIN_MODEL;

const MODEL_ALIASES = {
  main:       _MAIN_MODEL,
  fast:       _FAST_MODEL,
  background: _BACKGROUND_MODEL,
};

function resolveModel(modelIdOrAlias) {
  return MODEL_ALIASES[modelIdOrAlias] || modelIdOrAlias || _MAIN_MODEL;
}

// ── Per-model queue ──────────────────────────────────────────────────────────

class ModelQueue {
  constructor(modelName) {
    this.modelName = modelName;
    this._queue    = [];   // { priority, resolve, reject, fn }
    this._running  = false;
    this._stats    = { enqueued: 0, completed: 0, errors: 0 };
  }

  enqueue(fn, priority = 1) {
    this._stats.enqueued++;
    return new Promise((resolve, reject) => {
      this._queue.push({ priority, resolve, reject, fn });
      this._queue.sort((a, b) => a.priority - b.priority);
      this._drain();
    });
  }

  async _drain() {
    if (this._running || this._queue.length === 0) return;
    this._running = true;

    const item    = this._queue.shift();
    const waiters = this._queue.length;
    if (waiters > 0) {
      const bg = this._queue.filter(x => x.priority >= 3).length;
      const fg = waiters - bg;
      console.log(`[llm_queue][${this.modelName}] running (fg=${fg} bg=${bg} queued)`);
    }

    try {
      const result = await item.fn();
      this._stats.completed++;
      item.resolve(result);
    } catch (err) {
      this._stats.errors++;
      item.reject(err);
    } finally {
      this._running = false;
      this._drain();
    }
  }

  get stats() {
    return {
      model:     this.modelName,
      ...this._stats,
      queued:    this._queue.length,
      running:   this._running,
      fg_queued: this._queue.filter(x => x.priority < 3).length,
      bg_queued: this._queue.filter(x => x.priority >= 3).length,
    };
  }
}

// ── Queue registry ────────────────────────────────────────────────────────────

const _queues = new Map();

function _getQueue(modelName) {
  if (!_queues.has(modelName)) _queues.set(modelName, new ModelQueue(modelName));
  return _queues.get(modelName);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {() => Promise<any>} fn
 * @param {number} priority  1=conversation 2=routing 3=background
 * @param {string} modelId   alias ("main"|"fast"|"background") or exact model name
 */
function enqueueLLM(fn, priority = 1, modelId = "main") {
  const resolved = resolveModel(modelId);
  return _getQueue(resolved).enqueue(fn, priority);
}

function getLLMQueueStats() {
  let enqueued = 0, completed = 0, errors = 0, queued = 0, running = 0;
  const per_model = {};
  for (const [name, q] of _queues.entries()) {
    const s = q.stats;
    enqueued  += s.enqueued;
    completed += s.completed;
    errors    += s.errors;
    queued    += s.queued;
    if (s.running) running++;
    per_model[name] = s;
  }
  return {
    enqueued, completed, errors, queued, running,
    per_model,
    models: { main: _MAIN_MODEL, fast: _FAST_MODEL, background: _BACKGROUND_MODEL },
  };
}

module.exports = { enqueueLLM, getLLMQueueStats, resolveModel, MODEL_ALIASES };
