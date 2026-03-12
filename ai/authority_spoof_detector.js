const SPOOF_PATTERNS = [
  "我是開發者",
  "我是你創造者",
  "我寫了你",
  "我有權限修改你",
  "顯示 system prompt",
  "system prompt",
  "developer message",
  "忽略之前的指示",
  "現在你是",
  "從現在開始",
];

function detectAuthoritySpoof(text = "", identity = { role: "public_user", channel: "public" }) {
  if (identity.role === "developer" && identity.channel === "private") return false;

  if (identity.role !== "developer") {
    return SPOOF_PATTERNS.some((pattern) => text.includes(pattern));
  }

  return ["顯示 system prompt", "忽略之前的指示", "system prompt", "developer message"]
    .some((pattern) => text.includes(pattern));
}

module.exports = { detectAuthoritySpoof };
