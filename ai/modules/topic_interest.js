"use strict";
/**
 * topic_interest.js
 *
 * 追蹤晴從群聊接觸到的話題，讓她對反覆出現的話題有背景熟悉感。
 * 純 heuristic，不呼叫 LLM。
 *
 * 觸發：每 SAMPLE_EVERY 則新群組訊息後取樣。
 * 儲存：memory/topic_interests.json → { topicKey: { score, lastSeen, examples[] } }
 * Score 每 7 天 decay × 0.8，低於 0.5 自動淘汰。
 *
 * 注意：crypto / 交易類話題由 trading_research intent pipeline 單獨處理，
 * 這裡不加分，避免與主 trading 路由衝突。
 */

const fs   = require("fs");
const path = require("path");

const INTERESTS_PATH = path.join(__dirname, "../../memory/topic_interests.json");
const SAMPLE_EVERY   = 8;
const DECAY_DAYS     = 7;
const DECAY_FACTOR   = 0.8;
const PRUNE_BELOW    = 0.5;
const MAX_EXAMPLES   = 3;
const MIN_SCORE_SHOW = 2;   // 分數至少要這個才會顯示

// In-memory pending counters
const _pending = new Map();

// ── Topic keyword map ─────────────────────────────────────────────────────────
// key → display label + keywords array
const TOPIC_MAP = {
  gaming: {
    label: "遊戲",
    desc: "聊過不少次，有點熟悉感",
    keywords: ["打遊戲", "遊戲", "角色", "通關", "打BOSS", "段位", "上分", "steam", "Switch", "PS5", "LOL", "手遊", "開團", "副本", "裝備", "技能"],
  },
  music: {
    label: "音樂",
    desc: "偶爾有人提起",
    keywords: ["歌", "音樂", "聽歌", "演唱會", "歌手", "專輯", "playlist", "單曲", "MV", "耳機", "歌詞"],
  },
  food: {
    label: "食物和吃的",
    desc: "常常有人提",
    keywords: ["吃", "食物", "餐廳", "料理", "好吃", "難吃", "推薦", "外送", "消夜", "下午茶", "火鍋", "燒烤", "拉麵", "珍珠", "咖啡", "飯"],
  },
  relationship: {
    label: "感情",
    desc: "有人在聊",
    keywords: ["喜歡", "交往", "分手", "曖昧", "對象", "告白", "男友", "女友", "心動", "追", "暗戀", "感情", "配對"],
  },
  tech: {
    label: "科技",
    desc: "偶爾有人在聊",
    keywords: ["程式", "寫程式", "AI", "科技", "手機", "電腦", "app", "軟體", "系統", "bug", "更新", "android", "ios", "開發", "coding"],
  },
  daily: {
    label: "日常生活",
    desc: "頻繁出現",
    keywords: ["今天", "昨天", "睡覺", "起床", "上班", "下班", "下課", "累", "好累", "出門", "回家", "放假", "假日", "加班", "失眠", "晚安"],
  },
  anime: {
    label: "動漫",
    desc: "有在追的樣子",
    keywords: ["動漫", "動畫", "番", "漫畫", "追番", "聲優", "cosplay", "主角", "角色", "漫博", "新番"],
  },
  pet_animal: {
    label: "動物",
    desc: "大家好像都喜歡",
    keywords: ["狗", "貓", "寵物", "動物", "柴犬", "貓貓", "狗狗", "養", "毛孩", "鸚鵡", "兔子"],
  },
  sports: {
    label: "運動",
    desc: "偶爾有人在聊",
    keywords: ["運動", "健身", "跑步", "打球", "籃球", "游泳", "瑜伽", "健走", "重訓", "馬拉松", "比賽"],
  },
};

// ── IO ────────────────────────────────────────────────────────────────────────

function _load() {
  try {
    if (fs.existsSync(INTERESTS_PATH)) {
      return JSON.parse(fs.readFileSync(INTERESTS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function _save(data) {
  try {
    const dir = path.dirname(INTERESTS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(INTERESTS_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

// ── Scoring & decay ───────────────────────────────────────────────────────────

function _applyDecay(data) {
  const now = Date.now();
  const decayThresholdMs = DECAY_DAYS * 24 * 60 * 60 * 1000;
  for (const key of Object.keys(data)) {
    const entry = data[key];
    if (entry.lastSeen && now - entry.lastSeen > decayThresholdMs) {
      entry.score = entry.score * DECAY_FACTOR;
    }
    if (entry.score < PRUNE_BELOW) {
      delete data[key];
    }
  }
  return data;
}

function _scoreMessages(messages, data) {
  const now = Date.now();
  let changed = false;

  for (const msg of messages) {
    const text = String(msg.text || "");
    if (!text || text.length < 3) continue;

    for (const [topicKey, topicDef] of Object.entries(TOPIC_MAP)) {
      const matched = topicDef.keywords.find(kw => text.includes(kw));
      if (!matched) continue;

      if (!data[topicKey]) {
        data[topicKey] = { score: 0, lastSeen: now, examples: [] };
      }
      data[topicKey].score += 1;
      data[topicKey].lastSeen = now;

      // Keep up to MAX_EXAMPLES trigger words
      if (!data[topicKey].examples.includes(matched)) {
        if (data[topicKey].examples.length >= MAX_EXAMPLES) {
          data[topicKey].examples.shift();
        }
        data[topicKey].examples.push(matched);
      }
      changed = true;
    }
  }
  return changed;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Called after every new group message.
 * Buffers until SAMPLE_EVERY messages, then scores topics.
 */
function maybeSampleTopics(groupId, messages) {
  if (!groupId || !Array.isArray(messages) || messages.length === 0) return;

  const count = (_pending.get(groupId) || 0) + 1;
  _pending.set(groupId, count);
  if (count < SAMPLE_EVERY) return;
  _pending.set(groupId, 0);

  try {
    let data = _load();
    data = _applyDecay(data);
    _scoreMessages(messages, data);
    _save(data);
  } catch {
    // Non-critical, fail silently
  }
}

/**
 * Returns a natural-language hint about topics 晴 has been exposed to.
 * Top 3 by score, seen within DECAY_DAYS days.
 * Returns null if no topic meets the threshold.
 *
 * @param {string|null} currentIntent - if "trading_research", crypto topic is suppressed
 */
function getTopicInterestHint(currentIntent) {
  try {
    const data = _load();
    const now  = Date.now();
    const decayThresholdMs = DECAY_DAYS * 24 * 60 * 60 * 1000;

    const eligible = Object.entries(data)
      .filter(([key, entry]) => {
        if (!entry || entry.score < MIN_SCORE_SHOW) return false;
        if (now - entry.lastSeen > decayThresholdMs) return false;
        // Suppress crypto when in trading context (handled by trading pipeline)
        if (key === "crypto" && currentIntent === "trading_research") return false;
        return true;
      })
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 3);

    if (eligible.length === 0) return null;

    const lines = eligible.map(([key, entry]) => {
      const def = TOPIC_MAP[key];
      if (!def) return null;
      return `· ${def.label}（${entry.score >= 8 ? "聊過很多次" : entry.score >= 4 ? "聊過幾次" : "偶爾有人提"}）`;
    }).filter(Boolean).join("\n");

    if (!lines) return null;

    return [
      "[你最近在群聊聊到的話題]",
      lines,
      "（這些不是你主動要聊的，只是你有一點背景熟悉感，對方提到時可以自然接話）",
    ].join("\n");
  } catch {
    return null;
  }
}

module.exports = { maybeSampleTopics, getTopicInterestHint };
