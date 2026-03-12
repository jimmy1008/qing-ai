/**
 * memory_retriever.js
 *
 * Retrieves the most contextually relevant episodic memories for a given
 * user message, using embedding cosine similarity (with Jaccard fallback).
 *
 * Also builds the system prompt injection block for recalled memories.
 */

const { getEpisodes } = require("./episodic_store");
const { embed, cosineSimilarity } = require("./memory_embedder");

const TOP_K = 3;
const MIN_SIMILARITY_EMBED = 0.55;  // cosine threshold (embedding path)
const MIN_SIMILARITY_KEYWORD = 0.12; // Jaccard threshold (fallback path)

// Jaccard similarity for keyword fallback
function jaccardSimilarity(a, b) {
  const tokenize = (s) => new Set(String(s || "").toLowerCase().split(/[\s,.\-_]+/).filter((w) => w.length > 1));
  const setA = tokenize(a);
  const setB = tokenize(b);
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Find the top-K most relevant episodic memories for the given query.
 *
 * @param {string} globalUserKey
 * @param {string} queryText - the current user message
 * @returns {Promise<Array<{summary, event_type, importance, similarity}>>}
 */
async function retrieveMemories(globalUserKey, queryText) {
  if (!globalUserKey || !queryText || queryText.length < 5) return [];

  const episodes = getEpisodes(globalUserKey);
  if (!episodes.length) return [];

  // Attempt embedding-based retrieval
  const queryEmbedding = await embed(queryText);

  let scored;

  if (queryEmbedding) {
    // Embedding path: prefer episodes that also have embeddings stored
    const withEmbeddings = episodes.filter((ep) => Array.isArray(ep.embedding) && ep.embedding.length > 0);
    const withoutEmbeddings = episodes.filter((ep) => !ep.embedding || ep.embedding.length === 0);

    const embeddingScored = withEmbeddings.map((ep) => ({
      ...ep,
      similarity: cosineSimilarity(queryEmbedding, ep.embedding),
    }));

    // For episodes without stored embeddings, use keyword fallback
    const keywordScored = withoutEmbeddings.map((ep) => ({
      ...ep,
      similarity: jaccardSimilarity(queryText, ep.summary) * 0.6, // downweight keyword matches
    }));

    scored = [...embeddingScored, ...keywordScored].filter(
      (ep) => ep.similarity >= Math.min(MIN_SIMILARITY_EMBED * 0.7, MIN_SIMILARITY_KEYWORD),
    );
  } else {
    // Pure keyword fallback: embedding model not available
    scored = episodes.map((ep) => ({
      ...ep,
      similarity: jaccardSimilarity(queryText, ep.summary),
    })).filter((ep) => ep.similarity >= MIN_SIMILARITY_KEYWORD);
  }

  return scored
    .sort((a, b) => (b.similarity * b.importance) - (a.similarity * a.importance))
    .slice(0, TOP_K)
    .map(({ summary, event_type, importance, similarity }) => ({
      summary,
      event_type,
      importance,
      similarity: Number(similarity.toFixed(3)),
    }));
}

/**
 * Build the memory injection block for the system prompt.
 * Returns empty string if no memories to inject.
 *
 * @param {Array} memories - result of retrieveMemories()
 * @returns {string}
 */
function buildMemoryPromptBlock(memories) {
  if (!memories || memories.length === 0) return "";

  const lines = memories.map((m) => `- ${m.summary}`);

  return [
    "[Long-term Memory — recalled from past conversations]",
    "You remember the following about this user from previous conversations:",
    ...lines,
    "",
    "Rules for using recalled memories:",
    "- Only reference a memory if it is clearly relevant to the current message.",
    "- Reference naturally: '你之前說過...' / '我記得你提到...' / '你好像說過...'",
    "- Do NOT recite all memories at once or without context.",
    "- Do NOT fabricate details beyond what is listed. These are verified facts.",
    "- Do NOT ask the user to confirm the memory unless you genuinely need to clarify.",
  ].join("\n");
}

module.exports = { retrieveMemories, buildMemoryPromptBlock };
