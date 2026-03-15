"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const PROJECT_ROOT = path.join(__dirname, "..");
const ALLOWED_ROOTS = ["memory", "logs", "telemetry"].map((dir) => path.resolve(PROJECT_ROOT, dir));
const WRITE_TIMEOUT_MS = Number(process.env.MEMORY_SERVICE_TIMEOUT_MS || 5000);
const _queues = new Map();

function isMemoryServicePrimary() {
  return String(process.env.MEMORY_SERVICE_ROLE || "").toLowerCase() === "primary";
}

function isRemoteWriteEnabled() {
  return Boolean(process.env.MEMORY_SERVICE_URL) && !isMemoryServicePrimary();
}

function getTokenHeaders() {
  const token = process.env.MEMORY_SERVICE_TOKEN;
  return token ? { "x-memory-token": token } : {};
}

function resolveSafeFilePath(filePath) {
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(PROJECT_ROOT, String(filePath || ""));

  const allowed = ALLOWED_ROOTS.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!allowed) {
    throw new Error(`memory_service path outside allowed roots: ${resolved}`);
  }
  return resolved;
}

function enqueueWrite(filePath, writer) {
  const prev = _queues.get(filePath) || Promise.resolve();
  const next = prev.then(writer);
  _queues.set(filePath, next.catch(() => {}));
  return next.finally(() => {
    if (_queues.get(filePath) === next) _queues.delete(filePath);
  });
}

function appendLineSerialized(filePath, line) {
  const targetPath = resolveSafeFilePath(filePath);
  return enqueueWrite(targetPath, () => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.appendFileSync(targetPath, `${String(line || "")}\n`, "utf-8");
  });
}

async function postWrite(payload) {
  const baseUrl = String(process.env.MEMORY_SERVICE_URL || "").replace(/\/$/, "");
  if (!baseUrl) throw new Error("MEMORY_SERVICE_URL is not set");
  await axios.post(`${baseUrl}/internal/memory/write`, payload, {
    timeout: WRITE_TIMEOUT_MS,
    headers: getTokenHeaders(),
  });
}

function appendLine(filePath, line) {
  if (isRemoteWriteEnabled()) {
    return postWrite({ filePath, line });
  }
  return appendLineSerialized(filePath, line);
}

function validateInternalToken(req) {
  const expected = process.env.MEMORY_SERVICE_TOKEN;
  if (!expected) return true;
  return req.headers["x-memory-token"] === expected;
}

module.exports = {
  resolveSafeFilePath,
  enqueueWrite,
  appendLine,
  appendLineSerialized,
  validateInternalToken,
  isRemoteWriteEnabled,
  isMemoryServicePrimary,
};
