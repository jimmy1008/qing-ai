const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getNamedPage } = require("./browser_manager");
const { handleIncomingThreadComment } = require("./comment_listener");
const { isProcessed } = require("../../utils/threads_processed_store");

const NOTIFICATIONS_URL = "https://www.threads.com/activity";
const SEEN_IDS_PATH = path.join(__dirname, "../../telemetry/seen_notification_ids.json");
const MAX_SEEN = 1000;

let seenIds = loadSeenIds();
let scanInFlight = false;

function loadSeenIds() {
  try {
    if (fs.existsSync(SEEN_IDS_PATH)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_IDS_PATH, "utf-8")));
    }
  } catch { /* ignore */ }
  return new Set();
}

function recordSeenId(id) {
  seenIds.add(id);
  const arr = Array.from(seenIds).slice(-MAX_SEEN);
  seenIds = new Set(arr);
  try {
    fs.mkdirSync(path.dirname(SEEN_IDS_PATH), { recursive: true });
    fs.writeFileSync(SEEN_IDS_PATH, JSON.stringify(arr));
  } catch { /* ignore */ }
}

function makeNotifId(n) {
  const raw = `${n.authorUsername}::${n.postId || ""}::${String(n.text || "").slice(0, 80)}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

async function extractNotifications(page) {
  return page.evaluate(() => {
    const results = [];
    const seenKeys = new Set();

    // Collect candidate elements — try Threads notification list patterns
    let candidates = [
      ...document.querySelectorAll('[role="listitem"]'),
      ...document.querySelectorAll('[data-pressable-container="true"]'),
    ];

    // Fallback: children of any role="list" container
    if (!candidates.length) {
      const lists = document.querySelectorAll('[role="list"]');
      for (const list of lists) {
        candidates.push(...list.children);
      }
    }

    // Fallback: article elements
    if (!candidates.length) {
      candidates = [...document.querySelectorAll('article')];
    }

    // Last resort: any div with both a profile link and a post link
    if (!candidates.length) {
      const divs = [...document.querySelectorAll('div')];
      candidates = divs.filter(
        (d) => d.querySelector('a[href^="/@"]') && d.querySelector('a[href*="/post/"]'),
      ).slice(0, 60);
    }

    for (const item of candidates) {
      const fullText = (item.innerText || "").trim();
      if (!fullText || fullText.length < 5) continue;

      // Chinese Threads: "在你的貼文留言" / "在你的貼文回覆" / "回覆了你的留言"
      const isReply =
        /repl(ied|y)|replied to|回覆了(你|您)|在你的.{0,6}留言|在你的.{0,6}回覆|留言了你的|commented on/i.test(fullText);
      const isMention =
        /mention(ed|s)|提及|提到你|mentioned you|標記了你/i.test(fullText);

      if (!isReply && !isMention) continue;

      // Author username from first profile link
      const profileLink = item.querySelector('a[href^="/@"]');
      if (!profileLink) continue;

      const authorUsername = (profileLink.getAttribute("href") || "")
        .replace(/^\/@/, "")
        .split("?")[0]
        .split("/")[0];

      if (!authorUsername) continue;

      // Post link — prefer the deepest /post/ link
      const postAnchors = [...item.querySelectorAll('a[href*="/post/"]')];
      const postHref = postAnchors.length
        ? postAnchors[postAnchors.length - 1].getAttribute("href") || ""
        : "";
      const postUrl = postHref
        ? (postHref.startsWith("http") ? postHref : `https://www.threads.com${postHref}`)
        : null;
      const postIdMatch = postHref.match(/\/post\/([A-Za-z0-9_-]+)/);
      const postId = postIdMatch ? postIdMatch[1] : null;

      // Priority: extract comment text after colon separator (e.g. "在你的貼文留言：歡回")
      let commentText = "";
      const colonMatch = fullText.match(/[：:]\s*(.{2,200})$/);
      if (colonMatch) {
        commentText = colonMatch[1].replace(/\s*\d+\s*[分時天秒][鐘]?\s*前?\s*$/, "").trim();
      }

      // Fallback: scan child nodes
      if (!commentText) {
        const nodes = [...item.querySelectorAll("span, div")];
        for (const el of nodes) {
          if (el.children.length > 3) continue;
          const t = (el.innerText || "").trim();
          if (
            t.length >= 2 &&
            t.length < 500 &&
            !/repl(ied|y)|mention(ed)?|回覆了|提及了|提到你|followed|追蹤了|liked|喜歡了|在你的.*留言|在你的.*回覆|留言了你的|標記了你/i.test(t) &&
            !/^\d+[smhd]$/.test(t) &&
            !/^\d+\s*[分時天秒][鐘]?前?$/.test(t)
          ) {
            commentText = t;
            break;
          }
        }
      }

      const key = `${authorUsername}:${postId || ""}:${commentText.slice(0, 40)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      results.push({
        authorUsername,
        postUrl,
        postId,
        text: commentText,
        type: isReply ? "reply" : "mention",
      });

      if (results.length >= 30) break;
    }

    return results;
  });
}

async function debugPageStructure(page) {
  try {
    const info = await page.evaluate(() => ({
      url: location.href,
      listitems: document.querySelectorAll('[role="listitem"]').length,
      pressable: document.querySelectorAll('[data-pressable-container="true"]').length,
      lists: document.querySelectorAll('[role="list"]').length,
      articles: document.querySelectorAll("article").length,
      bodySnippet: (document.body.innerText || "").slice(0, 500),
    }));
    console.log("[NOTIF SCANNER] debug:", JSON.stringify(info));
  } catch { /* ignore */ }
}

async function runNotificationScan() {
  if (scanInFlight) {
    console.log("[NOTIF SCANNER] scan already in flight, skipping");
    return { skipped: true, reason: "in_flight" };
  }

  scanInFlight = true;

  try {
    const page = await getNamedPage("notif");
    console.log("[NOTIF SCANNER] navigate to activity page");
    await page.goto(NOTIFICATIONS_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);

    // Scroll to load more notification items
    for (let i = 0; i < 2; i++) {
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(1000);
    }

    const raw = await extractNotifications(page);
    console.log(`[NOTIF SCANNER] found ${raw.length} notification candidates`);
    if (raw.length === 0) await debugPageStructure(page);

    let processed = 0;
    let skipped = 0;

    for (const notif of raw) {
      const notifId = makeNotifId(notif);

      if (seenIds.has(notifId) || isProcessed(notifId)) {
        skipped++;
        continue;
      }

      console.log(
        `[NOTIF SCANNER] processing ${notif.type} from @${notif.authorUsername} post=${notif.postId || "unknown"}`,
      );

      const result = handleIncomingThreadComment({
        id: notifId,
        authorUsername: notif.authorUsername,
        text: notif.text,
        postId: notif.postId,
        postUrl: notif.postUrl,
      });

      if (result.emitted) {
        recordSeenId(notifId);
        processed++;
      } else {
        skipped++;
      }
    }

    console.log(
      `[NOTIF SCANNER] done: processed=${processed} skipped=${skipped} total=${raw.length}`,
    );
    return { processed, skipped, total: raw.length };
  } catch (err) {
    console.error("[NOTIF SCANNER] error:", err.message);
    return { error: err.message, processed: 0, skipped: 0, total: 0 };
  } finally {
    scanInFlight = false;
  }
}

module.exports = { runNotificationScan };
