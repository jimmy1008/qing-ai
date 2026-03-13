"use strict";
/**
 * llm_queue.js — Serialised priority queue for all Ollama calls.
 *
 * Why: Ollama is single-threaded; concurrent requests are queued
 * internally but treated FIFO.  A 60-second background LLM call
 * (scheduler / reflector) will stall every conversation request
 * behind it.  This queue lets conversation calls (priority 1) jump
 * ahead of background calls (priority 3).
 *
 * Usage:
 *   const { enqueueLLM } = require("./llm_queue");
 *
 *   // foreground (conversation) — default priority 1
 *   const result = await enqueueLLM(() => axios.post(...), 1);
 *
 *   // background (scheduler, reflector, market observer)
 *   const result = await enqueueLLM(() => axios.post(...), 3);
 *
 * Lower number = higher priority.
 * Requests with equal priority are served FIFO.
 */

class LLMQueue {
  constructor() {
    this._queue   = [];   // { priority, resolve, reject, fn }
    this._running = false;
    this._stats   = { enqueued: 0, completed: 0, errors: 0 };
  }

  /**
   * Enqueue an async function that makes a single Ollama call.
   * @param {() => Promise<any>} fn
   * @param {number} priority — 1 = highest (conversation), 3 = lowest (background)
   * @returns {Promise<any>}
   */
  enqueue(fn, priority = 1) {
    this._stats.enqueued++;
    return new Promise((resolve, reject) => {
      this._queue.push({ priority, resolve, reject, fn });
      // Keep sorted: lower number first; stable sort for equal priority
      this._queue.sort((a, b) => a.priority - b.priority);
      this._drain();
    });
  }

  async _drain() {
    if (this._running || this._queue.length === 0) return;
    this._running = true;

    const item = this._queue.shift();
    const waiters = this._queue.length;
    if (waiters > 0) {
      const bg = this._queue.filter(x => x.priority >= 3).length;
      const fg = waiters - bg;
      console.log(`[llm_queue] running (fg=${fg} bg=${bg} queued)`);
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
      ...this._stats,
      queued:   this._queue.length,
      running:  this._running,
      fg_queued: this._queue.filter(x => x.priority < 3).length,
      bg_queued: this._queue.filter(x => x.priority >= 3).length,
    };
  }
}

// Singleton — shared across the whole process
const _queue = new LLMQueue();

module.exports = {
  enqueueLLM: (fn, priority = 1) => _queue.enqueue(fn, priority),
  getLLMQueueStats: () => _queue.stats,
};
