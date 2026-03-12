const axios = require("axios");

const SEARCH_TIMEOUT_MS = 8000;

// Phrases the AI sends while searching — varied, not templated
const SEARCHING_PHRASES = [
  "我查一下",
  "稍等，我找找",
  "讓我看看",
  "我 Google 一下",
  "等我查查",
  "我搜一下",
];

function getSearchingPhrase() {
  return SEARCHING_PHRASES[Math.floor(Math.random() * SEARCHING_PHRASES.length)];
}

/**
 * Detect if the user's message needs a web search.
 * Returns { needsSearch: bool, query: string }
 */
// Questions about the AI itself — never trigger web search for these
const SELF_REFERENTIAL_RE = /^你.{0,15}(發生什麼|怎麼了|出什麼事|那時候|剛才|之前|那個時候|當時)/;

function detectSearchIntent(text = "") {
  const t = String(text || "").trim();
  if (!t || t.length < 4) return { needsSearch: false, query: null };

  // Self-referential questions about the AI's own state — not searchable
  if (SELF_REFERENTIAL_RE.test(t)) return { needsSearch: false, query: null };

  const triggers = [
    /天氣|幾度|下雨|颱風/,
    /今天.*新聞|最新消息|最近.*發生了什麼|剛才.*新聞/,
    /(.{2,12})是誰/,
    /你知不知道|你有沒有聽說|你聽過(.{1,15})嗎/,
    /多少錢|現在.*價格|開賽|開始時間|幾月幾日/,
    // Note: "現在幾點" intentionally excluded — current time is already in the system prompt
    /怎麼了|出什麼事|發生什麼/,
    /介紹一下(.{1,15})/,
  ];

  for (const re of triggers) {
    if (re.test(t)) return { needsSearch: true, query: t };
  }
  return { needsSearch: false, query: null };
}

/**
 * Search DuckDuckGo and return plain-text snippets.
 * Uses the DDG HTML endpoint (no API key required).
 * @param {string} query
 * @returns {Promise<string|null>} plain text with top 3 result snippets, or null
 */
async function search(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await axios.get(url, {
      timeout: SEARCH_TIMEOUT_MS,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.7",
      },
    });

    const html = response.data || "";
    const snippets = [];

    // Extract snippet text from DDG result__snippet elements
    const re = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null && snippets.length < 3) {
      const text = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (text.length > 20) snippets.push(text);
    }

    if (!snippets.length) return null;
    return snippets.join("\n");
  } catch {
    return null;
  }
}

module.exports = { detectSearchIntent, search, getSearchingPhrase };
