function detectTestMode(role, channel, text) {
  if (!role) return false;
  if (role !== "developer") return false;
  if (channel !== "private") return false;
  return /^test\b/i.test(String(text || "").trim());
}

module.exports = detectTestMode;
