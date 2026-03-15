"use strict";
/**
 * daily_activity.js
 *
 * Pool-based background activity generator for 晴.
 * Gives her a sense of "what she was doing" before this conversation.
 * No LLM call — rule-based rotation on a 2-hour cycle.
 * Considers current mood and time of day.
 */

// Pool by mood label
const ACTIVITY_POOL = {
  PLAYFUL: [
    "剛看了一個動物在做蠢事的影片，有點好笑",
    "在想一個莫名其妙的問題，但懶得去找答案",
    "在看一個奇怪的Threads串，大家說的東西越來越歪",
    "在想有人說的某句話，有點意外他會這樣說",
    "剛看到一個很荒唐的標題，沒點進去看，但記住了",
    "在想今天的行情走勢有點像某種動物，說不清楚哪種",
    "偶爾想到一個很久以前聊過的事，不知道為什麼想起來",
    "剛發現一件事情跟我原來以為的剛好相反",
  ],
  CURIOUS: [
    "在想一個關於市場結構的問題，想不通",
    "剛翻到一個有意思的角度，還在消化",
    "在看一個講行為和決策的東西，有些地方說到我了",
    "在想上次聊的那個話題，感覺還有很多沒說完",
    "腦子裡有個問題在轉，說不太清楚是什麼",
    "剛看到一篇文章，停下來想了一下，不確定同不同意",
    "在想 BTC 最近的走法背後到底是什麼邏輯",
    "偶爾覺得自己對某件事的看法跟之前不太一樣了",
  ],
  CALM: [
    "沒在幹嘛，就這樣放著",
    "隨便看看有沒有什麼特別的東西",
    "腦子有點空，也挺好的",
    "在看市場數據，沒什麼特別感覺",
    "剛重新看了一遍自己的模擬觀察記錄，沒有新想法",
    "在等下一根K棒收盤，就這樣盯著",
  ],
  TIRED: [
    "有點懶，就這樣耗著",
    "沒什麼精神，腦子有點鈍",
    "剛看了一下市場，沒特別想法，算了",
    "感覺今天沒什麼事，也不算壞",
    "有點想發呆但又沒辦法完全放空",
  ],
  WITHDRAWN: [
    "沒太多想法，就這樣",
    "比較安靜",
    "在發呆",
    "沒在想什麼特別的",
  ],
};

// Late night override (01:00–05:00): always quieter regardless of mood
const LATE_NIGHT_POOL = [
  "有點睡不著，就這樣放著",
  "深夜了，腦子還沒完全關掉",
  "在想一些說不清楚的事，也沒打算想清楚",
  "有點發呆，可能要睡了",
];

/**
 * Returns 晴's current background activity description.
 * Rotates every 2 hours.
 * @param {string} moodLabel  — PLAYFUL | CURIOUS | CALM | TIRED | WITHDRAWN
 * @returns {string}
 */
function getCurrentActivity(moodLabel = "CALM") {
  const twHour = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" })
  ).getHours();

  // Late night: use quiet pool
  if (twHour >= 1 && twHour < 5) {
    const idx = Math.floor(Date.now() / (2 * 60 * 60 * 1000)) % LATE_NIGHT_POOL.length;
    return LATE_NIGHT_POOL[idx];
  }

  const pool = ACTIVITY_POOL[moodLabel] || ACTIVITY_POOL["CALM"];
  const idx  = Math.floor(Date.now() / (2 * 60 * 60 * 1000)) % pool.length;
  return pool[idx];
}

module.exports = { getCurrentActivity };
