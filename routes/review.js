const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { requireAuth, requireSuperAdmin } = require("../auth/auth_middleware");
const { getAdapterDirs, findEvalReports, safeReadJson, TRAIN_DIR } = require("./lora");

const REVIEW_A_PATH = path.join(TRAIN_DIR, "review_a_state.json");
const REVIEW_B_PATH = path.join(TRAIN_DIR, "review_b_state.json");
const DATASET_V2_PATH = path.join(__dirname, "../../dataset_v2/dataset_v2_merged_5000.json");
const INFER_RESULTS_PATH = path.join(TRAIN_DIR, "inference_results.jsonl");

function readReview(p) { return safeReadJson(p) || null; }
function writeReview(p, state) { fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf-8"); }

let _genJob = { running: false, total: 0, done: 0, failed: 0, aborted: false, startedAt: null };

async function runGenerationJob(prompts, resumeSet, concurrency) {
  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  const model = process.env.LLM_MODEL || "qwen3:8b";
  const systemPrompt = "你是晴，一個真實的人在傳訊息。語氣口語自然，有個性。直接回應，不打招呼。最多2-3句。禁止emoji。";
  const fd = fs.openSync(INFER_RESULTS_PATH, "a");
  const todo = prompts.filter(p => !resumeSet.has(p._idx));

  async function processOne(item) {
    if (_genJob.aborted) return;
    try {
      const resp = await axios.post(`${ollamaUrl}/api/chat`, {
        model, stream: false, think: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: item.prompt },
        ],
      }, { timeout: 90000 });
      const reply = (resp.data?.message?.content || "").trim();
      const line = JSON.stringify({ idx: item._idx, category: item.category, prompt: item.prompt, reply, model, ts: Date.now() }) + "\n";
      fs.writeSync(fd, line);
      _genJob.done++;
    } catch { _genJob.failed++; }
  }

  for (let i = 0; i < todo.length; i += concurrency) {
    if (_genJob.aborted) break;
    await Promise.all(todo.slice(i, i + concurrency).map(processOne));
  }

  fs.closeSync(fd);
  _genJob.running = false;
}

// Auto-resume on server startup if partial progress exists
setTimeout(() => {
  try {
    if (!fs.existsSync(INFER_RESULTS_PATH) || !fs.existsSync(DATASET_V2_PATH)) return;
    const lines = fs.readFileSync(INFER_RESULTS_PATH, "utf-8").trim().split("\n").filter(Boolean);
    const fileCount = lines.length;
    if (fileCount === 0) return;
    const prompts = JSON.parse(fs.readFileSync(DATASET_V2_PATH, "utf-8")).map((p, i) => ({ ...p, _idx: i }));
    if (fileCount >= prompts.length) return;
    const resumeSet = new Set();
    lines.forEach(l => { try { resumeSet.add(JSON.parse(l).idx); } catch {} });
    console.log(`[GEN JOB] 自動恢復生成：已完成 ${fileCount}/${prompts.length}，繼續剩餘 ${prompts.length - fileCount} 條`);
    _genJob = { running: true, total: prompts.length, done: fileCount, failed: 0, aborted: false, startedAt: new Date().toISOString() };
    runGenerationJob(prompts, resumeSet, 3).catch(err => {
      console.error("[GEN JOB] 自動恢復失敗:", err.message);
      _genJob.running = false;
    });
  } catch (e) {
    console.error("[GEN JOB] 自動恢復檢查失敗:", e.message);
  }
}, 5000);

const SCORE_LABELS = ["", "語意錯誤", "勉強表達", "接不到情緒", "缺少人感", "完美"];

const router = express.Router();

router.post("/api/review/a/generate", requireAuth, requireSuperAdmin, async (req, res) => {
  if (_genJob.running) return res.json({ ok: false, message: "已在生成中", job: _genJob });
  if (!fs.existsSync(DATASET_V2_PATH)) return res.status(404).json({ ok: false, message: "找不到 dataset_v2_merged_5000.json" });
  const prompts = JSON.parse(fs.readFileSync(DATASET_V2_PATH, "utf-8")).map((p, i) => ({ ...p, _idx: i }));
  const resumeSet = new Set();
  if (fs.existsSync(INFER_RESULTS_PATH)) {
    fs.readFileSync(INFER_RESULTS_PATH, "utf-8").trim().split("\n").filter(Boolean).forEach(l => {
      try { resumeSet.add(JSON.parse(l).idx); } catch {}
    });
  }
  const concurrency = Math.min(10, Math.max(1, Number(req.body?.concurrency) || 3));
  _genJob = { running: true, total: prompts.length, done: resumeSet.size, failed: 0, aborted: false, startedAt: new Date().toISOString() };
  runGenerationJob(prompts, resumeSet, concurrency).catch(err => {
    console.error("[GEN JOB]", err.message);
    _genJob.running = false;
  });
  res.json({ ok: true, total: prompts.length, alreadyDone: resumeSet.size, remaining: prompts.length - resumeSet.size, concurrency });
});

router.get("/api/review/a/generate/status", requireAuth, (_req, res) => {
  let fileCount = 0;
  if (fs.existsSync(INFER_RESULTS_PATH)) {
    fileCount = fs.readFileSync(INFER_RESULTS_PATH, "utf-8").trim().split("\n").filter(Boolean).length;
  }
  const done = Math.max(_genJob.done, fileCount);
  const total = _genJob.total || 5000;
  res.json({ ..._genJob, done, fileCount, pct: (done / total * 100).toFixed(1) });
});

router.post("/api/review/a/generate/stop", requireAuth, requireSuperAdmin, (_req, res) => {
  _genJob.aborted = true;
  res.json({ ok: true, done: _genJob.done });
});

router.post("/api/review/a/init", requireAuth, requireSuperAdmin, (req, res) => {
  const source = req.body?.source || "training";

  if (source === "inference") {
    if (!fs.existsSync(INFER_RESULTS_PATH)) return res.status(404).json({ ok: false, message: "尚未生成推論結果，請先執行生成" });
    const lines = fs.readFileSync(INFER_RESULTS_PATH, "utf-8").trim().split("\n").filter(Boolean);
    const items = lines.map(l => {
      try {
        const d = JSON.parse(l);
        return { id: `inf_${d.idx}`, input: d.prompt, reply: d.reply, category: d.category, source: "inference", autoPass: null, forbiddenHits: [], artifact: false, status: "pending", reviewer: null, reviewedAt: null, note: "" };
      } catch { return null; }
    }).filter(Boolean);
    if (!items.length) return res.status(404).json({ ok: false, message: "推論結果檔案是空的" });
    const adapters = getAdapterDirs();
    const state = { source: "inference", adapter: adapters[0] || "unknown", initializedAt: new Date().toISOString(), items };
    writeReview(REVIEW_A_PATH, state);
    return res.json({ ok: true, total: items.length, source: "inference" });
  }

  if (source === "eval") {
    const reports = findEvalReports();
    if (!reports.length) return res.status(404).json({ ok: false, message: "找不到 eval report" });
    const latest = reports[0];
    const details = latest.data?.details || [];
    if (!details.length) return res.status(404).json({ ok: false, message: "eval report 沒有 details" });
    const state = {
      source: "eval", adapter: latest.data.adapter || latest.data.label, report: latest.file,
      initializedAt: new Date().toISOString(),
      items: details.map(d => ({
        id: d.id, input: d.input, reply: d.reply,
        autoPass: d.pass, forbiddenHits: d.forbiddenHits || [], artifact: d.artifact || false,
        status: "pending", reviewer: null, reviewedAt: null, note: "",
      })),
    };
    writeReview(REVIEW_A_PATH, state);
    return res.json({ ok: true, total: state.items.length, source: "eval" });
  }

  // source === "training"
  const items = [];
  if (fs.existsSync(TRAIN_DIR)) {
    const jsonlFiles = fs.readdirSync(TRAIN_DIR)
      .filter(n => n.endsWith(".jsonl") && n.startsWith("socialai_persona") && n.includes("train"))
      .sort();
    jsonlFiles.forEach(file => {
      const raw = fs.readFileSync(path.join(TRAIN_DIR, file), "utf-8").trim().split("\n");
      raw.forEach((line, i) => {
        try {
          const d = JSON.parse(line);
          const msgs = d.messages || d.conversations || [];
          const userMsg = msgs.find(m => m.role === "user");
          const assistantMsg = msgs.find(m => m.role === "assistant");
          if (userMsg && assistantMsg) {
            items.push({
              id: `${file.replace(".jsonl", "")}_${i + 1}`,
              input: userMsg.content, reply: assistantMsg.content, source: file,
              autoPass: null, forbiddenHits: [], artifact: false,
              status: "pending", reviewer: null, reviewedAt: null, note: "",
            });
          }
        } catch {}
      });
    });
  }
  const reports = findEvalReports();
  if (reports.length) {
    const latest = reports[0];
    (latest.data?.details || []).forEach(d => {
      if (!items.find(x => x.id === d.id)) {
        items.push({
          id: d.id, input: d.input, reply: d.reply, source: "eval",
          autoPass: d.pass, forbiddenHits: d.forbiddenHits || [], artifact: d.artifact || false,
          status: "pending", reviewer: null, reviewedAt: null, note: "",
        });
      }
    });
  }
  if (!items.length) return res.status(404).json({ ok: false, message: "找不到訓練資料" });
  const adapters = getAdapterDirs();
  const state = { source: "training", adapter: adapters[0] || "unknown", initializedAt: new Date().toISOString(), items };
  writeReview(REVIEW_A_PATH, state);
  res.json({ ok: true, total: items.length, source: "training" });
});

router.get("/api/review/a/progress", requireAuth, (_req, res) => {
  const state = readReview(REVIEW_A_PATH);
  if (!state) return res.json({ initialized: false, total: 0, done: 0, pending: 0, scores: {} });
  const items = state.items;
  const scores = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  items.forEach(x => { if (x.score) scores[x.score] = (scores[x.score] || 0) + 1; });
  res.json({
    initialized: true, adapter: state.adapter,
    total: items.length,
    done: items.filter(x => x.status !== "pending").length,
    pending: items.filter(x => x.status === "pending").length,
    scores,
  });
});

router.get("/api/review/a/next", requireAuth, (_req, res) => {
  const state = readReview(REVIEW_A_PATH);
  if (!state) return res.status(404).json({ ok: false, message: "尚未初始化" });
  const item = state.items.find(x => x.status === "pending");
  const done = state.items.filter(x => x.status !== "pending").length;
  if (!item) return res.json({ finished: true, total: state.items.length, done });
  res.json({ item, done, total: state.items.length, adapter: state.adapter });
});

router.post("/api/review/a/submit", requireAuth, (req, res) => {
  const { id, score, note } = req.body || {};
  const s = Number(score);
  if (!id || !s || s < 1 || s > 5) return res.status(400).json({ ok: false, message: "id and score (1-5) required" });
  const state = readReview(REVIEW_A_PATH);
  if (!state) return res.status(404).json({ ok: false, message: "尚未初始化" });
  const item = state.items.find(x => x.id === id);
  if (!item) return res.status(404).json({ ok: false, message: "找不到項目" });
  item.status = "scored";
  item.score = s;
  item.reviewer = (req.headers["x-team-token"] || "").slice(0, 8) + "…";
  item.reviewedAt = new Date().toISOString();
  item.note = note || "";
  writeReview(REVIEW_A_PATH, state);
  const done = state.items.filter(x => x.status !== "pending").length;
  res.json({ ok: true, done, total: state.items.length, allDone: done === state.items.length });
});

router.post("/api/review/a/reset", requireAuth, requireSuperAdmin, (_req, res) => {
  if (fs.existsSync(REVIEW_A_PATH)) fs.unlinkSync(REVIEW_A_PATH);
  res.json({ ok: true });
});

router.post("/api/review/b/init", requireAuth, requireSuperAdmin, (_req, res) => {
  const reports = findEvalReports().slice(0, 2);
  if (reports.length < 2) return res.status(404).json({ ok: false, message: "需要至少 2 個 eval report" });
  const [later, prev] = reports;
  const prevById = {};
  (prev.data?.details || []).forEach(x => { prevById[x.id] = x; });
  const pairs = (later.data?.details || [])
    .filter(x => prevById[x.id])
    .map(x => ({
      id: x.id, input: x.input,
      responseA: prevById[x.id].reply, labelA: prev.data?.label || prev.file,
      responseB: x.reply, labelB: later.data?.label || later.file,
      status: "pending", reviewer: null, reviewedAt: null,
    }));
  if (!pairs.length) return res.status(404).json({ ok: false, message: "兩個 report 沒有共同 id" });
  const state = { labelA: prev.data?.label, labelB: later.data?.label, initializedAt: new Date().toISOString(), items: pairs };
  writeReview(REVIEW_B_PATH, state);
  res.json({ ok: true, total: pairs.length, labelA: state.labelA, labelB: state.labelB });
});

router.get("/api/review/b/progress", requireAuth, (_req, res) => {
  const state = readReview(REVIEW_B_PATH);
  if (!state) return res.json({ initialized: false, total: 0, done: 0 });
  const items = state.items;
  res.json({
    initialized: true, labelA: state.labelA, labelB: state.labelB,
    total: items.length,
    done: items.filter(x => x.status !== "pending").length,
    a_better: items.filter(x => x.status === "a_better").length,
    b_better: items.filter(x => x.status === "b_better").length,
    tie: items.filter(x => x.status === "tie").length,
    skip: items.filter(x => x.status === "skip").length,
  });
});

router.get("/api/review/b/next", requireAuth, (_req, res) => {
  const state = readReview(REVIEW_B_PATH);
  if (!state) return res.status(404).json({ ok: false, message: "尚未初始化" });
  const item = state.items.find(x => x.status === "pending");
  const done = state.items.filter(x => x.status !== "pending").length;
  if (!item) return res.json({ done: true, total: state.items.length });
  res.json({ pair: item, done, total: state.items.length, labelA: state.labelA, labelB: state.labelB });
});

router.post("/api/review/b/submit", requireAuth, (req, res) => {
  const { id, preference } = req.body || {};
  if (!id || !preference) return res.status(400).json({ ok: false, message: "id and preference required" });
  const state = readReview(REVIEW_B_PATH);
  if (!state) return res.status(404).json({ ok: false, message: "尚未初始化" });
  const item = state.items.find(x => x.id === id);
  if (!item) return res.status(404).json({ ok: false, message: "找不到項目" });
  item.status = preference;
  item.reviewer = (req.headers["x-team-token"] || "").slice(0, 8) + "…";
  item.reviewedAt = new Date().toISOString();
  writeReview(REVIEW_B_PATH, state);
  const done = state.items.filter(x => x.status !== "pending").length;
  res.json({ ok: true, done, total: state.items.length, allDone: done === state.items.length });
});

router.post("/api/review/b/reset", requireAuth, requireSuperAdmin, (_req, res) => {
  if (fs.existsSync(REVIEW_B_PATH)) fs.unlinkSync(REVIEW_B_PATH);
  res.json({ ok: true });
});

module.exports = router;
