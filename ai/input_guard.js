function summarizeLongInput(text = "") {
  const normalized = String(text || "").replace(/\r/g, "").trim();
  if (!normalized) return "";

  const chunks = normalized
    .split(/\n{2,}|(?<=[。！？!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return chunks.slice(0, 5).join("\n").slice(0, 700).trim();
}

function guardInput(text = "") {
  const raw = String(text || "");
  const longTextDetected = raw.length > 800;
  const summarizedText = longTextDetected ? summarizeLongInput(raw) : raw;

  return {
    rawText: raw,
    userText: summarizedText || raw,
    longTextDetected,
    skipStableMemoryWrite: longTextDetected,
    externalTextSummary: longTextDetected ? summarizedText : "",
  };
}

module.exports = {
  guardInput,
};
