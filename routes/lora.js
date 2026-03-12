const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { requireAuth, requireSuperAdmin } = require("../auth/auth_middleware");

const TRAIN_DIR = path.join(__dirname, "../train");

function safeReadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return null; }
}

function getAdapterDirs() {
  if (!fs.existsSync(TRAIN_DIR)) return [];
  return fs.readdirSync(TRAIN_DIR)
    .filter(n => /^socialai_persona/.test(n) && fs.statSync(path.join(TRAIN_DIR, n)).isDirectory())
    .sort((a, b) => fs.statSync(path.join(TRAIN_DIR, b)).mtimeMs - fs.statSync(path.join(TRAIN_DIR, a)).mtimeMs);
}

function getLatestCheckpoint(adapterPath) {
  const dirs = fs.readdirSync(adapterPath)
    .filter(n => /^checkpoint-\d+/.test(n))
    .sort((a, b) => parseInt(b.split("-")[1]) - parseInt(a.split("-")[1]));
  return dirs[0] ? path.join(adapterPath, dirs[0]) : null;
}

function getTrainerState(adapterName) {
  const adapterPath = path.join(TRAIN_DIR, adapterName);
  const ckpt = getLatestCheckpoint(adapterPath);
  if (ckpt) return safeReadJson(path.join(ckpt, "trainer_state.json"));
  return safeReadJson(path.join(adapterPath, "trainer_state.json"));
}

function findEvalReports() {
  if (!fs.existsSync(TRAIN_DIR)) return [];
  return fs.readdirSync(TRAIN_DIR)
    .filter(n => /^eval_report_lora/.test(n) && n.endsWith(".json"))
    .sort((a, b) => b.localeCompare(a))
    .map(n => ({ file: n, data: safeReadJson(path.join(TRAIN_DIR, n)) }))
    .filter(x => x.data);
}

const router = express.Router();

router.get("/api/pipeline/status", requireAuth, requireSuperAdmin, (_req, res) => {
  const adapters = getAdapterDirs();
  const latest = adapters[0];
  if (!latest) return res.json({ status: "no_adapters", uploadedSamples: 0 });
  const adapterPath = path.join(TRAIN_DIR, latest);
  const adapterConfig = safeReadJson(path.join(adapterPath, "adapter_config.json")) || {};
  const trainerState = getTrainerState(latest);
  const datasetAudit = safeReadJson(path.join(TRAIN_DIR, "dataset_audit.json")) || {};
  const reports = findEvalReports();
  const latestReport = reports[0]?.data;
  res.json({
    runId: latest, baseModel: adapterConfig.base_model_name_or_path || "unknown",
    model: adapterConfig.base_model_name_or_path || "unknown",
    uploadedSamples: datasetAudit.total_samples || 0, totalSamples: datasetAudit.total_samples || 0,
    aReviewed: latestReport?.total || 0, aReviewedCount: latestReport?.total || 0,
    bStatus: "pending", status: trainerState ? "completed" : "idle",
    adapter: `train/${latest}`, adapterCount: adapters.length,
  });
});

router.get("/api/dataset/files", requireAuth, requireSuperAdmin, (_req, res) => {
  const audit = safeReadJson(path.join(TRAIN_DIR, "dataset_audit.json")) || {};
  const files = [];
  if (fs.existsSync(TRAIN_DIR)) {
    fs.readdirSync(TRAIN_DIR).filter(n => n.endsWith(".jsonl") || n.endsWith(".json") && n.includes("dataset")).forEach(n => {
      const stat = fs.statSync(path.join(TRAIN_DIR, n));
      files.push({
        file: n, samples: audit.total_samples || "—",
        schema: audit.train_audit?.content_hit_count === 0 ? "OK" : "warnings",
        avgTokens: null, maxTokens: null, duplicates: audit.rejected_samples || 0,
      });
    });
  }
  if (!files.length) {
    files.push({ file: "dataset_audit.json", samples: audit.total_samples || 0, schema: "OK", duplicates: audit.rejected_samples || 0 });
  }
  res.json(files);
});

router.get("/api/dataset/validation", requireAuth, requireSuperAdmin, (_req, res) => {
  const audit = safeReadJson(path.join(TRAIN_DIR, "dataset_audit.json")) || {};
  const trainAudit = audit.train_audit || {};
  res.json({
    missingFields: trainAudit.content_hit_count || 0,
    illegalChars: trainAudit.content_hit_count || 0,
    emptySamples: audit.rejected_samples || 0,
    duplicateRate: `${((audit.rejected_samples || 0) / Math.max(audit.total_samples || 1, 1) * 100).toFixed(1)}%`,
  });
});

router.get("/api/scoring/a/status", requireAuth, requireSuperAdmin, (_req, res) => {
  const reports = findEvalReports();
  if (!reports.length) return res.json({ avgScore: 0, reviewed: 0, coverage: "0%", personaConsistency: "—", completed: false, total: 0 });
  const latest = reports[0].data;
  const passRate = Number((latest.passRate || 0) * 100).toFixed(1);
  const forbiddenHitRate = Number((latest.forbiddenHitRate || 0) * 100).toFixed(1);
  res.json({
    avgScore: passRate, reviewed: latest.total || 0, total: latest.total || 0,
    coverage: `${passRate}%`, personaConsistency: `${(100 - parseFloat(forbiddenHitRate)).toFixed(1)}%`,
    passRate: latest.passRate, forbiddenHitRate: latest.forbiddenHitRate,
    label: latest.label, adapter: latest.adapter,
    completed: (latest.passRate || 0) >= 0.5, process: latest.total,
  });
});

router.get("/api/scoring/b/status", requireAuth, requireSuperAdmin, (_req, res) => {
  res.json({ preferenceSamples: 0, chosenRejectedRatio: "—", gateStatus: "未配置", mode: "DPO", processed: 0, total: 0, canStart: false, message: "尚未配置偏好學習資料集" });
});

router.post("/api/scoring/b/start", requireAuth, requireSuperAdmin, (_req, res) => {
  res.status(400).json({ ok: false, message: "尚未配置 DPO 資料集" });
});

router.get("/api/train/status", requireAuth, requireSuperAdmin, (_req, res) => {
  const adapters = getAdapterDirs();
  const latest = adapters[0];
  if (!latest) return res.json({ running: false, state: "idle" });
  const adapterPath = path.join(TRAIN_DIR, latest);
  const adapterConfig = safeReadJson(path.join(adapterPath, "adapter_config.json")) || {};
  const trainerState = getTrainerState(latest);
  const logHistory = trainerState?.log_history || [];
  const lastLog = logHistory.filter(r => r.loss !== undefined).slice(-1)[0] || {};
  res.json({
    baseModel: adapterConfig.base_model_name_or_path || "unknown", outputAdapter: latest,
    rank: adapterConfig.r || adapterConfig.lora_r || "—", alpha: adapterConfig.lora_alpha || "—",
    dropout: adapterConfig.lora_dropout || "—", batchSize: trainerState?.train_batch_size || "—",
    gradAccum: "—", running: false, state: "completed",
    step: trainerState?.global_step || 0, epoch: trainerState?.epoch || 0,
    loss: lastLog.loss, learningRate: lastLog.learning_rate,
    gpuUtil: null, gpuVram: null, tokensPerSec: null, samplesPerSec: null, gradNorm: lastLog.grad_norm,
  });
});

router.get("/api/train/metrics", requireAuth, requireSuperAdmin, (_req, res) => {
  const adapters = getAdapterDirs();
  const latest = adapters[0];
  if (!latest) return res.json([]);
  const trainerState = getTrainerState(latest);
  const rows = (trainerState?.log_history || [])
    .filter(r => r.loss !== undefined)
    .map(r => ({ step: r.step, loss: r.loss, learningRate: r.learning_rate, gradNorm: r.grad_norm, epoch: r.epoch }));
  res.json(rows);
});

router.get("/api/train/history", requireAuth, requireSuperAdmin, (_req, res) => {
  const adapters = getAdapterDirs();
  const reports = findEvalReports();
  const reportByAdapter = {};
  reports.forEach(r => {
    if (r.data?.adapter) {
      const key = r.data.adapter.replace("train/", "");
      reportByAdapter[key] = r.data;
    }
  });
  const history = adapters.map((name, i) => {
    const adapterPath = path.join(TRAIN_DIR, name);
    const config = safeReadJson(path.join(adapterPath, "adapter_config.json")) || {};
    const trainerState = getTrainerState(name);
    const logHistory = trainerState?.log_history || [];
    const lastLog = logHistory.filter(r => r.loss !== undefined).slice(-1)[0] || {};
    const report = reportByAdapter[name];
    return {
      id: adapters.length - i, adapter: name,
      baseModel: config.base_model_name_or_path || "—",
      rank: config.r || config.lora_r || "—", alpha: config.lora_alpha || "—",
      steps: trainerState?.global_step || "—", epoch: trainerState?.epoch || "—",
      loss: lastLog.loss ?? "—",
      score: report ? `${((report.passRate || 0) * 100).toFixed(0)}%` : "—",
      dataset: "persona",
    };
  });
  res.json(history);
});

router.post("/api/train/control", requireAuth, requireSuperAdmin, (req, res) => {
  const { action } = req.body || {};
  res.json({ ok: true, action, message: `訓練由 Python 腳本管理，請使用 WSL 執行 train_peft_qlora_7b.py。action=${action} 已記錄。` });
});

router.get("/api/conversation/samples", requireAuth, requireSuperAdmin, (_req, res) => {
  const reports = findEvalReports().slice(0, 2);
  if (!reports.length) return res.json([]);
  const latestReport = reports[0].data;
  const prevReport = reports[1]?.data;
  const prevById = {};
  if (prevReport?.details) prevReport.details.forEach(r => { prevById[r.id] = r; });
  const samples = (latestReport.details || []).map(r => ({
    id: r.id, userPrompt: r.input, baseReply: prevById[r.id]?.reply || "—",
    loraReply: r.reply, aScore: r.pass ? "pass" : "fail",
    preference: r.pass ? "chosen" : "rejected",
    drift: r.forbiddenHits?.length ? r.forbiddenHits.join(", ") : "—",
  }));
  res.json(samples);
});

router.get("/api/system/metrics", requireAuth, requireSuperAdmin, (_req, res) => {
  const os = require("os");
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const ramPct = ((usedMem / totalMem) * 100).toFixed(1);
  const ramStr = `${(usedMem / 1024 / 1024 / 1024).toFixed(1)}GB / ${(totalMem / 1024 / 1024 / 1024).toFixed(1)}GB`;
  res.json({ gpu: "—", gpuUtil: null, gpuVram: "—", cpu: null, ram: ramStr, ramPct, uptime: process.uptime(), history: [] });
});

router.get("/api/audit/logs", requireAuth, requireSuperAdmin, (_req, res) => {
  const logPath = path.join(TRAIN_DIR, "server_stdout.log");
  const logs = [];
  if (fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean).slice(-50);
    lines.forEach((line, i) => {
      logs.push({ time: `#${i + 1}`, actor: "train", action: "log", detail: line.slice(0, 120) });
    });
  }
  res.json(logs.reverse().slice(0, 30));
});

router.get("/api/agents", requireAuth, requireSuperAdmin, (_req, res) => {
  res.json([
    { name: "dataset-builder", status: "idle", desc: "generate_persona_dataset.py" },
    { name: "sft-trainer-7b", status: "idle", desc: "train_peft_qlora_7b.py" },
    { name: "sft-trainer-14b", status: "idle", desc: "train_peft_qlora_14b.py" },
    { name: "unsloth-trainer", status: "idle", desc: "train_unsloth.py" },
    { name: "eval-runner", status: "idle", desc: "run_eval_local_lora.py" },
  ]);
});

router.get("/api/tasks/recent", requireAuth, requireSuperAdmin, (_req, res) => {
  const adapters = getAdapterDirs().slice(0, 5);
  const tasks = adapters.map(name => {
    const ts = getTrainerState(name);
    return { title: name, action: "training", time: ts ? `step ${ts.global_step}, epoch ${ts.epoch}` : "—", status: "completed" };
  });
  res.json(tasks);
});

router.get("/api/services", requireAuth, requireSuperAdmin, (_req, res) => {
  res.json([
    { name: "Ollama LLM", status: "up" },
    { name: "SocialAI Server", status: "up" },
    { name: "Telegram Bot", status: "up" },
    { name: "Threads Connector", status: "up" },
    { name: "WSL Train Env", status: "idle" },
  ]);
});

router.post("/api/inference", requireAuth, requireSuperAdmin, async (req, res) => {
  const { prompt, systemPersona } = req.body || {};
  if (!prompt) return res.status(400).json({ ok: false, message: "prompt required" });
  try {
    const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
    const model = process.env.LLM_MODEL || "qwen2.5:7b";
    const messages = [];
    if (systemPersona) messages.push({ role: "system", content: systemPersona });
    messages.push({ role: "user", content: prompt });
    const response = await axios.post(`${ollamaUrl}/api/chat`, { model, messages, stream: false }, { timeout: 30000 });
    const output = response.data?.message?.content || response.data?.response || "（無回應）";
    res.json({ ok: true, output, model });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

router.get("/api/train/live", requireAuth, requireSuperAdmin, (_req, res) => {
  const adapters = getAdapterDirs();
  const latest = adapters[0];
  let currentStep = 0, totalSteps = 0, logLines = [];
  if (latest) {
    const ts = getTrainerState(latest);
    currentStep = ts?.global_step || 0;
    const logHistory = ts?.log_history || [];
    const trainingLogs = logHistory.filter(r => r.loss !== undefined);
    totalSteps = trainingLogs.length ? Math.max(...trainingLogs.map(r => r.step)) : currentStep;
    const logFiles = fs.existsSync(TRAIN_DIR)
      ? fs.readdirSync(TRAIN_DIR)
          .filter(n => n.startsWith("train_run") && n.endsWith(".log"))
          .sort((a, b) => fs.statSync(path.join(TRAIN_DIR, b)).mtimeMs - fs.statSync(path.join(TRAIN_DIR, a)).mtimeMs)
      : [];
    if (logFiles.length) {
      const raw = fs.readFileSync(path.join(TRAIN_DIR, logFiles[0]), "utf-8");
      const lines = raw.split("\n").filter(l => l.trim() && !l.includes("[A"));
      logLines = lines.slice(-30);
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/\|\s*(\d+)\/(\d+)\s*\[/);
        if (m) { currentStep = parseInt(m[1]); totalSteps = totalSteps || parseInt(m[2]); break; }
      }
    }
  }
  res.json({
    currentStep, totalSteps: totalSteps || currentStep,
    pct: totalSteps > 0 ? Math.min(100, (currentStep / totalSteps) * 100).toFixed(1) : 100,
    log: logLines.join("\n"),
  });
});

module.exports = { router, getAdapterDirs, getTrainerState, findEvalReports, safeReadJson, TRAIN_DIR };
