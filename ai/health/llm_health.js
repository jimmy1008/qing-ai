"use strict";

const axios = require("axios");
const { execSync } = require("child_process");
const { getLLMQueueStats } = require("../llm_queue");
const { MAIN_MODEL, FAST_MODEL } = require("../llm_client");

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const FALLBACK_URL = process.env.OLLAMA_FALLBACK_URL || "";
const FALLBACK_KEY = process.env.OLLAMA_FALLBACK_API_KEY || "";

async function checkModelAvailability() {
  try {
    const resp = await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 5000 });
    const names = new Set((resp.data?.models || []).map((m) => m.name));
    return {
      reachable: true,
      availableModels: Array.from(names),
      mainAvailable: names.has(MAIN_MODEL),
      fastAvailable: names.has(FAST_MODEL),
    };
  } catch (err) {
    return {
      reachable: false,
      availableModels: [],
      mainAvailable: false,
      fastAvailable: false,
      error: err.message,
    };
  }
}

function getGpuUsage() {
  try {
    const out = execSync("nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).toString("utf8").trim();
    if (!out) return { status: "unknown" };
    const [util, memUsed, memTotal] = out.split("\n")[0].split(",").map((x) => Number(String(x).trim()));
    return {
      status: "ok",
      utilizationGpuPct: util,
      memoryUsedMb: memUsed,
      memoryTotalMb: memTotal,
    };
  } catch {
    return { status: "unknown" };
  }
}

function getFallbackReadiness() {
  return {
    enabled: Boolean(FALLBACK_URL && FALLBACK_KEY),
    url: FALLBACK_URL || null,
    ready: Boolean(FALLBACK_URL && FALLBACK_KEY),
  };
}

async function getLLMHealth() {
  const started = Date.now();
  const availability = await checkModelAvailability();
  return {
    timestamp: new Date().toISOString(),
    model: {
      main: MAIN_MODEL,
      fast: FAST_MODEL,
      availability,
    },
    queue: getLLMQueueStats(),
    gpu: getGpuUsage(),
    fallback: getFallbackReadiness(),
    latencyMs: Date.now() - started,
  };
}

module.exports = { getLLMHealth };
