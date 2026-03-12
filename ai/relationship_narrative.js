// Builds an explicit [RelationshipContext] block injected into the system prompt.
// Gives the AI a natural-language narrative of who it's talking to.
function buildRelationshipContextBlock(context = {}) {
  const name = context.event?.username || null;
  const role = context.role || "public_user";
  const channel = context.channel || "private";
  const familiarity = Number(context.relationship?.familiarity || 0);
  const interactionCount = Number(context.relationship?.interactionCount || 0);
  const sharedMemories = (context.relationship?.sharedMemories || []).slice(0, 3);

  // Don't leak personal memories into group chats (except developer)
  if (channel === "group" && role !== "developer") return null;
  // Skip for strangers who have barely interacted
  if (interactionCount < 3 && familiarity < 20 && role !== "developer") return null;

  const lines = ["[RelationshipContext]"];
  if (name) lines.push(`你正在和「${name}」對話。`);

  if (role === "developer") {
    lines.push("他是創建你的開發者。你深度信任他，說話可以更直接自然，不需要表演。");
  } else if (familiarity >= 80) {
    lines.push("你們互動很頻繁，已經很熟悉了。語氣可以輕鬆，偶爾帶點調侃。");
  } else if (familiarity >= 50) {
    lines.push("你們有過不少互動，算是認識的人了。");
  } else {
    lines.push("你們有過一些互動。");
  }

  if (sharedMemories.length > 0) {
    lines.push("你們之間有些記憶：");
    sharedMemories.forEach((m) => lines.push(`- ${m.text}`));
  }

  lines.push("用這些背景自然地說話。不要生硬地背誦或刻意提起這些記憶。");
  return lines.join("\n");
}

function buildRelationshipNarrative({ relationshipLevel, mood, recentInteractionWeight }) {
  const descriptions = {
    stranger: "我們還不太熟。",
    casual: "我們偶爾聊聊。",
    familiar: "我們互動還挺多的。",
    close: "我很在意你。",
  };

  const toneModifiers = {
    stranger: "reserved",
    casual: "light",
    familiar: "warm",
    close: "close",
  };

  const description = descriptions[relationshipLevel];
  const toneModifier = toneModifiers[relationshipLevel];

  if (!description || !toneModifier) {
    throw new Error(`invalid_relationship_level:${relationshipLevel}`);
  }

  return {
    description,
    toneModifier,
    mood: mood || "CALM",
    recentInteractionWeight: Number(recentInteractionWeight || 0),
  };
}

module.exports = {
  buildRelationshipNarrative,
  buildRelationshipContextBlock,
};
