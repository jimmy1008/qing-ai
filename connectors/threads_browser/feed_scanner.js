function normalizeText(text) {
  return String(text || "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const UI_NOISE_TOKENS = [
  "登入", "Log in", "Sign in",
  "追蹤", "Follow",
  "讚", "Like",
  "回覆", "Reply",
  "分享", "Share",
  "搜尋", "Search",
  "首頁", "Home",
];

function looksLikePostText(text) {
  if (!text) return false;
  const value = text.trim();
  if (value.length < 20) return false;

  const hits = UI_NOISE_TOKENS.filter((token) => value.includes(token)).length;
  if (hits >= 6 && value.length < 120) {
    return false;
  }

  return true;
}

async function getDomDebug(page, selectors) {
  const debug = {
    ok: false,
    url: null,
    title: null,
    bodyTextPreview: null,
    selectorCounts: {},
    pickedSelector: null,
    pickedCount: 0,
    note: null,
  };

  try {
    debug.url = page.url();
  } catch {
    // ignore
  }

  try {
    debug.title = await page.title();
  } catch {
    // ignore
  }

  try {
    debug.bodyTextPreview = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return text.slice(0, 500);
    });
  } catch {
    // ignore
  }

  for (const selector of selectors) {
    try {
      debug.selectorCounts[selector] = await page.locator(selector).count();
    } catch {
      debug.selectorCounts[selector] = -1;
    }
  }

  return debug;
}

async function extractPostsFromAnchors(page, anchorSelector, limit) {
  const anchors = page.locator(anchorSelector);
  const count = await anchors.count();
  const posts = [];

  for (let i = 0; i < Math.min(count, 80); i += 1) {
    const anchor = anchors.nth(i);
    const container = anchor.locator(
      "xpath=ancestor-or-self::*[self::div or self::section or self::article][1]",
    );

    let text = "";
    try {
      text = await container.innerText();
    } catch {
      text = "";
    }

    const cleaned = normalizeText(text);
    if (!looksLikePostText(cleaned)) {
      continue;
    }

    let href = "";
    try {
      href = (await anchor.getAttribute("href")) || "";
    } catch {
      href = "";
    }

    const normalizedHref = href.startsWith("http")
      ? href
      : href
        ? `https://www.threads.com${href}`
        : null;
    const authorMatch = href.match(/\/@([^/?#]+)/i);
    const authorUsername = authorMatch ? authorMatch[1] : null;

    posts.push({
      id: `feed-${Date.now()}-${i}`,
      text: cleaned.slice(0, 2000),
      url: normalizedHref,
      authorUsername,
      _selector: anchorSelector,
      _index: i,
    });

    if (posts.length >= limit) {
      break;
    }
  }

  return posts;
}

function dedupePosts(posts) {
  const seen = new Set();
  const output = [];

  for (const post of posts) {
    const key = String(post.text || "").slice(0, 120);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(post);
  }

  return output;
}

async function scanFeed(page, limit = 5) {
  const anchorSelectors = [
    'a[href*="/post/"]',
    'a[href^="/@"]',
    'a[href*="/@"]',
  ];

  const debug = await getDomDebug(page, anchorSelectors);

  let posts = [];
  for (const selector of anchorSelectors) {
    const count = debug.selectorCounts[selector] || 0;
    if (count <= 0) {
      continue;
    }

    posts = await extractPostsFromAnchors(page, selector, limit);
    posts = dedupePosts(posts);

    if (posts.length > 0) {
      debug.ok = true;
      debug.pickedSelector = selector;
      debug.pickedCount = count;
      debug.note = `Extracted ${posts.length} posts from anchor selector.`;
      return { posts, debug };
    }
  }

  debug.ok = false;
  debug.note = "Anchors found but no readable post containers extracted. Need refine ancestor container or filters.";
  return { posts: [], debug };
}

module.exports = { scanFeed };
