/**
 * memory_embedder.js
 *
 * Thin wrapper around Ollama's embedding API.
 * Provides cosine similarity for vector search.
 *
 * Falls back gracefully if the embedding model is not installed —
 * memory retrieval will use keyword overlap instead.
 */

const axios = require("axios");

const EMBED_BASE = (process.env.OLLAMA_ENDPOINT || "http://localhost:11434/api/generate")
  .replace(/\/api\/generate$/, "");
const EMBED_ENDPOINT = `${EMBED_BASE}/api/embeddings`;
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";
const EMBED_TIMEOUT_MS = 5000;

/**
 * Generate an embedding vector for the given text.
 * Returns float[] or null on failure.
 */
async function embed(text) {
  const t = String(text || "").trim().slice(0, 1000);
  if (!t) return null;

  try {
    const resp = await axios.post(
      EMBED_ENDPOINT,
      { model: EMBED_MODEL, prompt: t },
      { timeout: EMBED_TIMEOUT_MS },
    );
    const embedding = resp.data?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) return null;
    return embedding;
  } catch {
    // Embedding model not installed or Ollama busy — silent fallback
    return null;
  }
}

/**
 * Cosine similarity between two equal-length float arrays.
 * Returns a value in [-1, 1].
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

module.exports = { embed, cosineSimilarity };
