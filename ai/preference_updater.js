const { ensurePreferenceProfile } = require("./preference_profile");
const { clamp } = require("../utils/math");

const TAG_RULES = [
  { tag: "cute_animals", pattern: /(可愛|好可愛|貓|小貓|貓咪|狗|小狗|兔子|動物)/i, delta: 0.18 },
  { tag: "dessert", pattern: /(甜點|蛋糕|草莓|餅乾|布丁|奶茶|點心)/i, delta: 0.14 },
  { tag: "daily_life", pattern: /(今天|日常|生活|分享|晚餐|早餐|上班|放假)/i, delta: 0.08 },
  { tag: "games", pattern: /(遊戲|switch|steam|pokemon|任天堂)/i, delta: 0.08 },
  { tag: "memes", pattern: /(迷因|梗圖|meme|笑死|哈哈哈)/i, delta: 0.08 },
  { tag: "creative", pattern: /(畫圖|創作|寫作|攝影|剪輯|設計)/i, delta: 0.1 },
];

const AVOID_RULES = [
  { tag: "politics", pattern: /(政治|選舉|政黨|立委|總統|辯論)/i, delta: 0.2 },
  { tag: "finance", pattern: /(投資|股票|幣圈|交易|財報|做多|做空)/i, delta: 0.18 },
  { tag: "adult", pattern: /(成人|18\+|情色|性愛|porn|nsfw|onlyfans)/i, delta: 0.25 },
  { tag: "gambling", pattern: /(賭博|博彩|下注|賭盤)/i, delta: 0.22 },
];

function pushEvidence(profile, entry) {
  profile.evidence.push({
    ...entry,
    timestamp: new Date().toISOString(),
  });
  if (profile.evidence.length > 20) {
    profile.evidence = profile.evidence.slice(-20);
  }
}

function applyDecay(map, rate = 0.985) {
  Object.keys(map).forEach((key) => {
    map[key] = Number((map[key] * rate).toFixed(4));
    if (map[key] < 0.01) {
      delete map[key];
    }
  });
}

function updateWeight(map, tag, delta) {
  const prev = Number(map[tag] || 0);
  map[tag] = clamp(Number((prev + delta).toFixed(4)), 0, 5);
}

function extractPreferenceSignals(text = "") {
  const raw = String(text || "");
  const hits = [];
  for (const rule of TAG_RULES) {
    if (rule.pattern.test(raw)) {
      hits.push({ kind: "tag", tag: rule.tag, delta: rule.delta });
    }
  }
  for (const rule of AVOID_RULES) {
    if (rule.pattern.test(raw)) {
      hits.push({ kind: "avoid", tag: rule.tag, delta: rule.delta });
    }
  }
  return hits;
}

function updatePreferenceProfile(memory, text, source = "chat") {
  ensurePreferenceProfile(memory);
  const profile = memory.preferenceProfile;
  applyDecay(profile.tags);
  applyDecay(profile.avoid, 0.99);
  const signals = extractPreferenceSignals(text);
  for (const signal of signals) {
    if (signal.kind === "tag") {
      updateWeight(profile.tags, signal.tag, signal.delta);
    } else {
      updateWeight(profile.avoid, signal.tag, signal.delta);
    }
    pushEvidence(profile, {
      source,
      kind: signal.kind,
      tag: signal.tag,
      delta: signal.delta,
      snippet: String(text || "").slice(0, 120),
    });
  }
  profile.lastUpdatedAt = Date.now();
  return profile;
}

function updateRelationshipBias(memory, signal = "neutral", delta = 0) {
  ensurePreferenceProfile(memory);
  const bias = memory.relationshipBias;
  bias.score = clamp(Number(((bias.score || 0) + delta).toFixed(4)), -5, 5);
  if (bias.score > 1.2) {
    bias.stance = "warm";
  } else if (bias.score < -1.2) {
    bias.stance = "guarded";
  } else {
    bias.stance = "neutral";
  }
  bias.lastUpdatedAt = Date.now();
  if (signal && signal !== "neutral") {
    bias.lastSignal = signal;
  }
  return bias;
}

function updateGroupTaste(memory, text, source = "group_chat") {
  ensurePreferenceProfile(memory);
  const taste = memory.groupTaste;
  applyDecay(taste.tags);
  applyDecay(taste.avoid, 0.99);
  const signals = extractPreferenceSignals(text);
  for (const signal of signals) {
    if (signal.kind === "tag") {
      updateWeight(taste.tags, signal.tag, signal.delta);
    } else {
      updateWeight(taste.avoid, signal.tag, signal.delta);
    }
    pushEvidence(taste, {
      source,
      kind: signal.kind,
      tag: signal.tag,
      delta: signal.delta,
      snippet: String(text || "").slice(0, 120),
    });
  }
  taste.lastUpdatedAt = Date.now();
  return taste;
}

module.exports = {
  extractPreferenceSignals,
  updatePreferenceProfile,
  updateRelationshipBias,
  updateGroupTaste,
};
