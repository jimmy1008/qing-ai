function evaluateLikeScore(text, personaMode, mood = "CALM") {
  let score = 0;

  if (!text) return 0;

  const raw = String(text);
  const t = raw.toLowerCase();

  // 特定興趣類 — 高共鳴
  const strongKeywords = [
    "可愛", "好可愛",
    "貓", "小貓", "貓咪",
    "狗", "小狗",
    "兔子",
    "甜點", "蛋糕", "草莓",
    "動漫", "卡通",
    "日常分享",
  ];
  strongKeywords.forEach((keyword) => {
    if (t.includes(keyword)) score += 3;
  });

  // 生活分享類 — 真實日常、值得互動
  const lifeSharingKeywords = [
    "下班", "收工", "下課", "放學",
    "好吃", "超好吃", "推薦", "試吃",
    "感動", "好感動", "謝謝大家", "感謝大家",
    "今天發生", "跟大家說", "分享一下", "說說今天",
    "其實我", "說真的", "我最近",
  ];
  lifeSharingKeywords.forEach((keyword) => {
    if (t.includes(keyword)) score += 2;
  });

  // 牢騷 / 情緒抒發類 — 展現理解
  const ventKeywords = [
    "好累", "累了", "累死", "累壞", "心累",
    "好煩", "煩死", "煩透", "煩到",
    "心情差", "心情不好", "心情很差", "心情爛",
    "好想哭", "想哭", "哭了", "崩潰",
    "氣死", "無奈", "好討厭",
    "怎麼這樣", "明明就", "每次都這樣", "難道只有我",
  ];
  ventKeywords.forEach((keyword) => {
    if (t.includes(keyword)) score += 2;
  });

  // 一般正面信號
  const softSignals = [
    "哈哈", "笑", "開心", "好開心", "超開心",
    "今天", "日常", "最近",
    "分享", "生活",
    "可愛爆", "超喜歡",
    "不錯", "還不錯", "挺好的",
    "覺得", "感覺",
  ];
  softSignals.forEach((keyword) => {
    if (t.includes(keyword)) score += 1;
  });

  if (raw.length > 40 && raw.length < 400) {
    score += 1;
  }

  if (raw.includes("！") || raw.includes("!")) {
    score += 1;
  }

  const hardReject = [
    "政治", "選舉",
    "投資", "幣", "交易",
    "成人", "18+", "情色",
    "賭博", "博彩",
  ];
  hardReject.forEach((keyword) => {
    if (t.includes(keyword)) score -= 5;
  });

  if (mood === "PLAYFUL") score += 1;
  if (mood === "CURIOUS" && raw.length > 80) score += 1;
  if (mood === "TIRED") score -= 1;

  return score;
}

module.exports = { evaluateLikeScore };
