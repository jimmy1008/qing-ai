const crypto = require("crypto");
const { isProcessed, markProcessed } = require("../../utils/threads_processed_store");
const { emitIncomingEvent } = require("../../core/event_bus");
const { hasSelfPost } = require("./self_posts_store");
const { getNamedPage } = require("./browser_manager");

/**
 * Fetch recent comments/mentions by scraping the Threads activity page.
 */
async function fetchRecentComments(lookbackMinutes = 60) {
  try {
    const page = await getNamedPage("notif");
    await page.goto("https://www.threads.com/activity", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);

    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(800);
    }

    const items = await page.evaluate(() => {
      const results = [];
      const seenKeys = new Set();

      let candidates = [
        ...document.querySelectorAll('[role="listitem"]'),
        ...document.querySelectorAll('[data-pressable-container="true"]'),
      ];

      if (!candidates.length) {
        const lists = document.querySelectorAll('[role="list"]');
        for (const list of lists) candidates.push(...list.children);
      }

      for (const item of candidates) {
        const fullText = (item.innerText || "").trim();
        if (!fullText || fullText.length < 8) continue;

        const isReply = /repl(ied|y)|replied to|回覆了(你|您)|在你的.{0,6}留言|在你的.{0,6}回覆|留言了你的|commented on/i.test(fullText);
        const isMention = /mention(ed|s)|提及|提到你|mentioned you|標記了你/i.test(fullText);
        if (!isReply && !isMention) continue;

        const profileLink = item.querySelector('a[href^="/@"]');
        if (!profileLink) continue;

        const authorUsername = (profileLink.getAttribute("href") || "")
          .replace(/^\/@/, "").split("?")[0].split("/")[0];
        if (!authorUsername) continue;

        const postAnchors = [...item.querySelectorAll('a[href*="/post/"]')];
        const postHref = postAnchors.length
          ? postAnchors[postAnchors.length - 1].getAttribute("href") || ""
          : "";
        const postUrl = postHref
          ? (postHref.startsWith("http") ? postHref : `https://www.threads.com${postHref}`)
          : null;
        const postIdMatch = postHref.match(/\/post\/([A-Za-z0-9_-]+)/);
        const postId = postIdMatch ? postIdMatch[1] : null;

        let commentText = "";
        const nodes = [...item.querySelectorAll("span, div")];
        for (const el of nodes) {
          if (el.children.length > 3) continue;
          const t = (el.innerText || "").trim();
          if (
            t.length >= 5 && t.length < 500 &&
            !/repl(ied|y)|mention(ed)?|回覆了|提及了|提到你|followed|追蹤了|liked|喜歡了/i.test(t) &&
            !/^\d+[smhd]$/.test(t)
          ) {
            commentText = t;
            break;
          }
        }

        const key = `${authorUsername}:${postId || ""}:${commentText.slice(0, 40)}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        results.push({
          authorUsername,
          postId,
          postUrl,
          text: commentText,
          type: isReply ? "NEW_COMMENT_ON_OWN_POST" : "MENTION",
          timestamp: new Date().toISOString(),
        });

        if (results.length >= 50) break;
      }

      return results;
    });

    return items.map((item) => {
      const raw = `${item.authorUsername}::${item.postId || ""}::${String(item.text || "").slice(0, 80)}`;
      item.id = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
      return item;
    });
  } catch (err) {
    console.error("[BACKFILL] fetchRecentComments error:", err.message);
    return [];
  }
}

async function backfillRecentComments(lookbackMinutes = 60) {
  try {
    const comments = await fetchRecentComments(lookbackMinutes);

    let rebuilt = 0;
    let skipped = 0;

    for (const comment of comments) {
      // Skip if already processed
      if (isProcessed(comment.id)) {
        skipped++;
        continue;
      }

      // Only backfill safe event types
      const allowedTypes = [
        "NEW_COMMENT_ON_OWN_POST",
        "NEW_REPLY_TO_SOCIALAI",
        "MENTION",
      ];

      const commentType = comment.type || "NEW_COMMENT_ON_OWN_POST";
      if (!allowedTypes.includes(commentType)) {
        skipped++;
        continue;
      }

      // Determine if this is on own post
      const isOwnPost =
        hasSelfPost(comment.postId) ||
        String(comment.postOwnerId || "") === "self";

      // Rebuild event
      const event = {
        type: "comment",
        prioritySource: "threads",
        platform: "threads",
        connector: "threads_browser",
        channel: "public",
        chatType: "public",
        interactionSource: isOwnPost ? null : "external_reply",
        postId: comment.postId || null,
        postAuthorId: isOwnPost ? "self" : (comment.postOwnerId || "external"),
        userId: comment.authorId || null,
        username: comment.authorUsername || null,
        authorUsername: comment.authorUsername || null,
        text: comment.text || "",
        content: comment.text || "",
        commentId: comment.id || null,
        originalPost: {
          postId: comment.postId || null,
          authorUsername: comment.postAuthorUsername || null,
          content: comment.postText || "",
          url: comment.postUrl || null,
        },
        originalComment: {
          commentId: comment.id || null,
          username: comment.authorUsername || null,
          content: comment.text || "",
        },
        postOwnerId: isOwnPost ? "self" : (comment.postOwnerId || "external"),
        timestamp: comment.timestamp || new Date().toISOString(),
      };

      // Emit to event bus (will go through normal scheduler → planner flow)
      const scheduled = emitIncomingEvent(event, {
        selfId: "self",
        skipCooldown: false,
      });

      // Only mark as processed if event was successfully emitted
      if (scheduled) {
        markProcessed(comment.id);
        rebuilt++;
      } else {
        skipped++;
      }
    }

    return {
      rebuilt,
      skipped,
      total: comments.length,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error("[BACKFILL] Error during backfill:", error);
    throw error;
  }
}

module.exports = {
  backfillRecentComments,
  fetchRecentComments,
};
