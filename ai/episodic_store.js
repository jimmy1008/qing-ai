"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { randomUUID } = require("crypto");
const { semanticDuplicateCheck } = require("./memory/episodic_dedup");
const { splitByTier, enforceTierCaps, MILESTONE_THRESHOLD } = require("./memory/milestone_tier");
const { summarizeOverflowEpisodes } = require("./memory/episodic_summarizer");

const _writeQueues = new Map();

function enqueueWrite(globalUserKey, fn) {
  const prev = _writeQueues.get(globalUserKey) || Promise.resolve();
  const next = prev.then(fn).catch(() => {});
  _writeQueues.set(globalUserKey, next);
  next.then(() => {
    if (_writeQueues.get(globalUserKey) === next) _writeQueues.delete(globalUserKey);
  });
  return next;
}

const EPISODES_DIR = path.join(__dirname, "../memory/episodes");
const MAX_EPISODES_PER_USER = 200;
const DEDUP_JACCARD_THRESHOLD = 0.65;
const DEDUP_SEMANTIC_CANDIDATE_THRESHOLD = Number(process.env.DEDUP_SEMANTIC_CANDIDATE_THRESHOLD || 0.35);

const DECAY_TIERS = [
  { maxImportance: 0.5, maxAgeMs: 4 * 24 * 60 * 60 * 1000 },
  { maxImportance: 0.8, maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
];

const MEMORY_SERVICE_URL = String(process.env.MEMORY_SERVICE_URL || "").replace(/\/$/, "");
const MEMORY_SERVICE_TIMEOUT_MS = Number(process.env.MEMORY_SERVICE_TIMEOUT_MS || 8000);

function shouldUseRemoteStore(options = {}) {
  if (options.localOnly) return false;
  if (!MEMORY_SERVICE_URL) return false;
  const role = String(process.env.MEMORY_SERVICE_ROLE || "").toLowerCase();
  return role !== "primary";
}

function getMemoryServiceHeaders() {
  const token = process.env.MEMORY_SERVICE_TOKEN;
  return token ? { "x-memory-token": token } : {};
}

function ensureDir() {
  fs.mkdirSync(EPISODES_DIR, { recursive: true });
}

function safeKey(globalUserKey) {
  return String(globalUserKey || "unknown").replace(/[^a-zA-Z0-9_\-]/g, "_");
}

function getEpisodesPath(globalUserKey) {
  ensureDir();
  return path.join(EPISODES_DIR, `${safeKey(globalUserKey)}.jsonl`);
}

function loadEpisodes(globalUserKey) {
  const fpath = getEpisodesPath(globalUserKey);
  if (!fs.existsSync(fpath)) return [];
  try {
    return fs.readFileSync(fpath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((ep) => ep && ep.summary);
  } catch {
    return [];
  }
}

function saveEpisodes(globalUserKey, episodes, options = {}) {
  if (shouldUseRemoteStore(options)) {
    return axios.post(`${MEMORY_SERVICE_URL}/internal/memory/episode/save`, {
      globalUserKey,
      episodes,
    }, {
      timeout: MEMORY_SERVICE_TIMEOUT_MS,
      headers: getMemoryServiceHeaders(),
    }).then(() => true).catch(() => false);
  }

  const fpath = getEpisodesPath(globalUserKey);
  const content = episodes.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const tmpPath = fpath + ".tmp";
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, fpath);
  return true;
}

function jaccardSimilarity(a, b) {
  const tokenize = (s) => new Set(String(s || "").toLowerCase().split(/[\s,.\-_]+/).filter((w) => w.length > 1));
  const setA = tokenize(a);
  const setB = tokenize(b);
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function applyDecay(episodes) {
  const now = Date.now();
  return episodes.filter((ep) => {
    const importance = Number(ep.importance || 0);
    const age = now - Number(ep.created_at || 0);
    if (importance >= MILESTONE_THRESHOLD) return true;
    for (const tier of DECAY_TIERS) {
      if (importance < tier.maxImportance) return age <= tier.maxAgeMs;
    }
    return true;
  });
}

function normalizeAndTrimEpisodes(allEpisodes = []) {
  const { milestone, normal } = splitByTier(allEpisodes);
  const decayedNormal = applyDecay(normal);
  let enforced = enforceTierCaps({ milestone, normal: decayedNormal });

  if (enforced.dropped.normal > 0) {
    const summary = summarizeOverflowEpisodes(decayedNormal, enforced.dropped.normal, "normal");
    if (summary) {
      enforced = enforceTierCaps({
        milestone: enforced.milestone,
        normal: [...enforced.normal, summary],
      });
    }
  }

  if (enforced.dropped.milestone > 0) {
    const summary = summarizeOverflowEpisodes(milestone, enforced.dropped.milestone, "milestone");
    if (summary) {
      enforced = enforceTierCaps({
        milestone: [...enforced.milestone, summary],
        normal: enforced.normal,
      });
    }
  }

  return [...enforced.milestone, ...enforced.normal]
    .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))
    .slice(0, MAX_EPISODES_PER_USER);
}

function storeEpisode(globalUserKey, { event_type, summary, importance, embedding, emotional_tag }, options = {}) {
  if (!globalUserKey || !summary) return Promise.resolve(null);

  if (shouldUseRemoteStore(options)) {
    return axios.post(`${MEMORY_SERVICE_URL}/internal/memory/episode/store`, {
      globalUserKey,
      event_type,
      summary,
      importance,
      embedding,
      emotional_tag,
    }, {
      timeout: MEMORY_SERVICE_TIMEOUT_MS,
      headers: getMemoryServiceHeaders(),
    }).then((resp) => resp.data?.episode || null).catch(() => null);
  }

  return enqueueWrite(globalUserKey, async () => {
    const episodes = loadEpisodes(globalUserKey);
    const now = Date.now();

    const lexicalDuplicate = episodes.some((ep) => jaccardSimilarity(ep.summary, summary) >= DEDUP_JACCARD_THRESHOLD);
    if (lexicalDuplicate) return null;

    const semanticCandidates = episodes
      .map((ep) => ({ ep, score: jaccardSimilarity(ep.summary, summary) }))
      .filter((x) => x.score >= DEDUP_SEMANTIC_CANDIDATE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.ep);

    if (semanticCandidates.length > 0) {
      const semantic = await semanticDuplicateCheck(summary, semanticCandidates);
      if (semantic?.duplicate && semantic.matchedId) {
        const idx = episodes.findIndex((ep) => ep.id === semantic.matchedId);
        if (idx >= 0) {
          const prev = episodes[idx];
          episodes[idx] = {
            ...prev,
            importance: Math.min(1, Math.max(Number(prev.importance || 0), Number(importance || 0))),
            last_seen_at: now,
            evidence_count: Number(prev.evidence_count || 1) + 1,
          };
          saveEpisodes(globalUserKey, normalizeAndTrimEpisodes(episodes), options);
          return null;
        }
      }
    }

    const episode = {
      id: randomUUID(),
      user_id: globalUserKey,
      event_type: String(event_type || "GENERAL"),
      summary: String(summary),
      importance: Number(importance || 0.7),
      emotional_tag: emotional_tag ? String(emotional_tag).slice(0, 30) : null,
      embedding: embedding || null,
      created_at: now,
      last_seen_at: now,
      evidence_count: 1,
    };

    saveEpisodes(globalUserKey, normalizeAndTrimEpisodes([...episodes, episode]), options);
    return episode;
  });
}

function getEpisodes(globalUserKey) {
  return loadEpisodes(globalUserKey);
}

function getEpisodeCount(globalUserKey) {
  return loadEpisodes(globalUserKey).length;
}

function consolidateEpisodes(globalUserKey) {
  return enqueueWrite(globalUserKey, () => {
    const episodes = loadEpisodes(globalUserKey);
    if (episodes.length < 5) {
      return { before: episodes.length, after: episodes.length, removed: 0, merged: 0 };
    }

    const normalized = normalizeAndTrimEpisodes(episodes);
    saveEpisodes(globalUserKey, normalized, { localOnly: true });

    return {
      before: episodes.length,
      after: normalized.length,
      removed: episodes.length - normalized.length,
      merged: 0,
    };
  });
}

module.exports = {
  storeEpisode,
  getEpisodes,
  getEpisodeCount,
  consolidateEpisodes,
  saveEpisodes,
};
