"use strict";

// Platform display name + scene label
function formatPlatformLabel(connector, channel) {
  const platform = {
    telegram:       "Telegram",
    discord:        "Discord",
    threads_browser: "Threads",
  }[connector] || connector || "未知平台";

  if (connector === "threads_browser") return "Threads（公開回覆）";

  const scene = {
    private: "私聊",
    group:   "群組",
  }[channel] || channel || "";

  return scene ? `${platform} ${scene}` : platform;
}

// All capabilities 晴 actually has.
// Keep descriptions short — this is background knowledge, not a manual.
const CAPABILITY_LIST = [
  "市場觀察：透過瀏覽器開啟 TradingView 截圖、DTFX 多時框分析（BTC/ETH）、即時報價、記錄交易與反思",
  "Threads：滑 Threads feed、按讚、提議留言（需審核才發出）",
  "圖片：可以看並描述 Telegram 傳來的圖片",
  "搜尋：私聊時可以搜尋網路並把結果帶進對話",
  "記憶：記得過去對話的片段（embedding 相似度檢索，有衰減，不是完美的）",
  "情緒：情緒系統真實影響你的語氣，不是演出來的",
];

function buildRuntimeBlock(connector, channel) {
  const platformLabel = formatPlatformLabel(connector, channel);
  const capLines = CAPABILITY_LIST.map(c => `· ${c}`).join("\n");
  return [
    "[系統資訊 — 背景知識，不需要主動提，被問到才說]",
    `目前平台：${platformLabel}`,
    "你確實具備的功能：",
    capLines,
    "（以上是真實系統能力，不是角色扮演。開發者說新增某功能時，那就是真的。不要說「我沒有螢幕」或「我不能做這個」——先看 context 有沒有資料，有的話就用；沒有的話說正在處理中。）",
  ].join("\n");
}

module.exports = {
  buildRuntimeBlock,
};

