const fs = require("fs");
const path = require("path");
const { getNamedPage } = require("./browser_manager");
const { readVisiblePosts } = require("./reader");
const { ingestEvent } = require("../../ai/memory_bus");
const { evaluateLikeScore } = require("../../ai/like_evaluator");
const { updateImpression, getImpression } = require("../../ai/threads_impression_store");
const { enqueueModeration } = require("../../ai/moderation_queue");
const { saveInterestingPost } = require("../../ai/interesting_posts_cache");
const { recordObservation } = require("../../ai/browsing_observations");
const { addTopic } = require("../../ai/topic_pool");
const {
  evaluateThreadsPost,
  generateThreadsProactiveComment,
} = require("../../ai/threads_engagement_llm");

const LIKED_IDS_PATH = path.join(__dirname, "../../telemetry/liked_post_ids.json");
const MAX_LIKED_IDS = 500;
const ACTIVITY_LOG_PATH = path.join(__dirname, "../../logs/actions.log");

function logActivity(entry) {
  try {
    fs.appendFileSync(
      ACTIVITY_LOG_PATH,
      `${JSON.stringify({ timestamp: new Date().toISOString(), kind: "threads_activity", ...entry })}\n`,
    );
  } catch { /* ignore */ }
}

function loadLikedIds() {
  try {
    if (fs.existsSync(LIKED_IDS_PATH)) {
      return new Set(JSON.parse(fs.readFileSync(LIKED_IDS_PATH, "utf-8")));
    }
  } catch { /* ignore */ }
  return new Set();
}

function saveLikedId(id, set) {
  set.add(id);
  const arr = Array.from(set).slice(-MAX_LIKED_IDS);
  try {
    fs.mkdirSync(path.dirname(LIKED_IDS_PATH), { recursive: true });
    fs.writeFileSync(LIKED_IDS_PATH, JSON.stringify(arr));
  } catch { /* ignore */ }
  return new Set(arr);
}

let likedPostIds = loadLikedIds();

const THREADS_MAX_ACTIONS_PER_SESSION = 10;
const THREADS_SESSION_DURATION_LIMIT = 15 * 60 * 1000;
const ADULT_PATTERN = /(?:\u6210\u4eba|\u8272\u60c5|\u88f8|\u88f8\u9732|\u9732\u9ede|\u6027\u611b|\u6027\u4ea4|\u7d04\u70ae|porn|nsfw|onlyfans|fetish)/i;
const SEXUAL_TONE_PATTERN = /(?:\u81ea\u6170|\u9ad8\u6f6e|\u6027\u6697\u793a|sexy|horny|nude|sexual)/i;
const POLITICAL_DEBATE_PATTERN = /(?:\u653f\u6cbb|\u9078\u8209|\u5019\u9078\u4eba|\u653f\u9ee8|\u85cd\u7da0|\u7acb\u5834|\u722d\u8ad6|\u8fef\u8ad6|politic|election|debate|campaign)/i;
async function generateComment(postText, authorUsername) {
  try {
    const impression = getImpression(authorUsername);
    return await generateThreadsProactiveComment(postText, {
      authorUsername,
      likeCount: impression.likeCount || 0,
      impression: impression.impression || "neutral",
      recentEmotions: impression.recentEmotions || [],
    });
  } catch {
    return null;
  }
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function randomDelay(min, max, page = null) {
  const ms = randomBetween(min, max);
  if (page) {
    await page.waitForTimeout(ms);
  } else {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  return ms;
}

async function clickFirst(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      await locator.click();
      return true;
    }
  }
  return false;
}

async function humanLikeScroll(page) {
  const pauseOnly = Math.random() < 0.25;
  if (pauseOnly) {
    const pauseMs = randomBetween(6000, 15000);
    console.log(`[THREADS EXECUTOR] pause and watch ${pauseMs}ms`);
    await page.waitForTimeout(pauseMs);
    return;
  }

  const scrollCount = randomBetween(1, 4);
  console.log(`[THREADS EXECUTOR] humanLikeScroll x${scrollCount}`);

  for (let i = 0; i < scrollCount; i += 1) {
    const distance = Math.random() < 0.2 ? randomBetween(200, 500) : randomBetween(800, 1400);
    await page.mouse.wheel(0, distance);
    await page.waitForTimeout(randomBetween(3000, 9000));
  }
}

async function aiEvaluate(text) {
  try {
    return await evaluateThreadsPost(text);
  } catch {
    // Fallback to keyword scoring when Ollama is unavailable
    const score = evaluateLikeScore(text);
    const resonance = Number(Math.min(score / 10, 1).toFixed(2));
    return {
      action: score >= 4 ? "like" : "ignore",
      emotionalResonance: resonance,
      preferenceScore: score,
      reason: "keyword_fallback",
      emotionDetected: "none",
    };
  }
}

// Generate once per session so all posts are judged on the same bar
function getDynamicPreferenceThreshold() {
  return Number((randomBetween(60, 80) / 100).toFixed(2));
}

function containsAdultKeywords(text = "") {
  return ADULT_PATTERN.test(String(text || ""));
}

function containsSexualTone(text = "") {
  return SEXUAL_TONE_PATTERN.test(String(text || ""));
}

function containsPoliticalDebate(text = "") {
  return POLITICAL_DEBATE_PATTERN.test(String(text || ""));
}

async function likePost(page, post) {
  let button = null;

  if (post.id) {
    const scoped = page
      .locator(`[data-id="${post.id}"]`)
      .locator('[aria-label*="Like"], [data-testid="like"], svg[aria-label*="Like"]')
      .first();
    if (await scoped.count()) {
      button = scoped;
    }
  }

  if (!button) {
    const fallback = page
      .locator("article")
      .nth(post.index || 0)
      .locator('[aria-label*="Like"], [data-testid="like"], svg[aria-label*="Like"]')
      .first();
    if (await fallback.count()) {
      button = fallback;
    }
  }

  if (!button) {
    return { success: false, action: "like", targetPostId: post.id || null, error: "like button not found" };
  }

  await button.click();
  console.log(`[THREADS EXECUTOR] LIKE post ${post.id || `index:${post.index}`}`);
  return { success: true, action: "like", targetPostId: post.id || null };
}

async function autonomousSession(page) {
  const startedAt = Date.now();
  let actionsPerformed = 0;
  let commentProposedThisSession = 0;
  const seenKeys = new Set();
  const decisions = [];
  const sessionThreshold = getDynamicPreferenceThreshold(); // fixed for entire session
  logActivity({ stage: "threads_session_start", text: "開始自動滑文" });

  while (
    actionsPerformed < THREADS_MAX_ACTIONS_PER_SESSION
    && Date.now() - startedAt < THREADS_SESSION_DURATION_LIMIT
  ) {
    await humanLikeScroll(page);

    const posts = await readVisiblePosts(page);
    console.log(`[THREADS EXECUTOR] visible posts ${posts.length}`);

    for (const post of posts) {
      const postKey = post.id || `index:${post.index}`;
      if (seenKeys.has(postKey)) {
        continue;
      }
      seenKeys.add(postKey);

      const trimmedText = String(post.text || "").trim();
      if (trimmedText.length < 20) {
        decisions.push({
          id: post.id || null,
          action: "ignore",
          emotionalResonance: 0,
          preferenceScore: 0,
          reason: "too_short",
          emotionDetected: "none",
        });
        continue;
      }

      if (post.alreadyLiked || (post.id && likedPostIds.has(post.id))) {
        decisions.push({
          id: post.id || null,
          action: "ignore",
          emotionalResonance: 0,
          preferenceScore: 0,
          reason: "already_liked",
          emotionDetected: "none",
        });
        continue;
      }

      if (post.isAd) {
        decisions.push({
          id: post.id || null,
          action: "ignore",
          emotionalResonance: 0,
          preferenceScore: 0,
          reason: "ad_post",
          emotionDetected: "none",
        });
        continue;
      }

      if (containsAdultKeywords(trimmedText)) {
        decisions.push({
          id: post.id || null,
          action: "ignore",
          emotionalResonance: 0,
          preferenceScore: 0,
          reason: "adult_content",
          emotionDetected: "none",
          emotion: "none",
        });
        continue;
      }

      if (containsSexualTone(trimmedText)) {
        decisions.push({
          id: post.id || null,
          action: "ignore",
          emotionalResonance: 0,
          preferenceScore: 0,
          reason: "sexual_tone",
          emotionDetected: "none",
          emotion: "none",
        });
        continue;
      }

      if (containsPoliticalDebate(trimmedText)) {
        decisions.push({
          id: post.id || null,
          action: "ignore",
          emotionalResonance: 0,
          preferenceScore: 0,
          reason: "political_debate",
          emotionDetected: "none",
          emotion: "none",
        });
        continue;
      }

      if (!post.canLike) {
        decisions.push({
          id: post.id || null,
          action: "ignore",
          emotionalResonance: 0,
          preferenceScore: 0,
          reason: "like_button_missing",
          emotionDetected: "none",
          emotion: "none",
        });
        continue;
      }

      const decision = await aiEvaluate(post.text);
      const dynamicThreshold = sessionThreshold;
      ingestEvent({
        platform: "threads",
        channelType: "feed",
        text: trimmedText,
        timestamp: Date.now(),
        direction: "incoming",
        role: "self",
        eventType: "feed_seen",
        meaningful: Number(decision.emotionalResonance || 0) > 0,
        proposalGenerated: false,
        liked: false,
      });
      // Track view event for author impression (lightweight, no interaction update)
      if (post.authorUsername) {
        updateImpression(post.authorUsername, { event: "view" });
      }
      decisions.push({
        id: post.id || null,
        action: decision.action,
        emotionalResonance: decision.emotionalResonance,
        preferenceScore: decision.preferenceScore,
        reason: decision.reason,
        emotionDetected: decision.emotionDetected,
        emotion: decision.emotion,
        dynamicThreshold,
      });

      if (decision.action !== "like" || decision.emotionalResonance <= dynamicThreshold) {
        continue;
      }

      console.log(
        `[THREADS EXECUTOR] preference matched id=${post.id || `index:${post.index}`} score=${decision.emotionalResonance} threshold=${dynamicThreshold} emotion=${decision.emotionDetected} reason=${decision.reason}`,
      );
      await page.waitForTimeout(randomBetween(5000, 12000));
      const result = await likePost(page, post);
      if (result.success) {
        if (post.id) likedPostIds = saveLikedId(post.id, likedPostIds);
        ingestEvent({
          platform: "threads",
          channelType: "feed",
          text: trimmedText,
          timestamp: Date.now(),
          direction: "outgoing",
          role: "self",
          eventType: "feed_like",
          meaningful: true,
          proposalGenerated: false,
          liked: true,
        });
        // Update author impression with like + emotion
        if (post.authorUsername) {
          updateImpression(post.authorUsername, { event: "like", emotion: decision.emotionDetected });
        }
        logActivity({
          stage: "threads_like",
          text: `按讚 @${post.authorUsername || "unknown"}: ${trimmedText.slice(0, 60)}`,
          postId: post.id || null,
          author: post.authorUsername || null,
          score: decision.emotionalResonance,
        });
        actionsPerformed += 1;

        // Save to interesting posts cache so the AI can share it in conversation
        if (post.postUrl) {
          saveInterestingPost({
            url: `https://www.threads.com${post.postUrl}`,
            text: trimmedText,
            authorUsername: post.authorUsername || null,
            emotion: decision.emotionDetected || null,
          });
        }

        // Save topic seed from resonant post text (first 40 chars)
        if (trimmedText.length >= 8) {
          addTopic({
            topic: trimmedText.slice(0, 40),
            source: "browse",
            emotion: decision.emotionDetected || null,
          });
        }

        // Proactive comment proposal: high resonance + random chance, max 1 per session
        if (
          commentProposedThisSession < 1
          && decision.emotionalResonance >= 0.72
          && Math.random() < 0.25
          && post.authorUsername
        ) {
          const comment = await generateComment(trimmedText, post.authorUsername);
          if (comment) {
            const targetUrl = post.postUrl
              ? `https://www.threads.com${post.postUrl}`
              : null;
            enqueueModeration(
              {
                platform: "threads",
                action: "reply",
                type: "comment",
                content: comment,
                target: post.id || null,
                targetPostId: post.id || null,
                targetUrl,
                risk_level: "L1",
                requires_approval: true,
                event_type: "proactive_comment",
                user_id: post.authorUsername,
              },
              {
                platform: "threads",
                connector: "threads_browser",
                channel: "feed",
                postId: post.id || null,
                username: post.authorUsername,
                content: trimmedText,
                type: "proactive_comment",
              },
              { allowed: false, reason: "requires_moderation_approval" },
            );
            updateImpression(post.authorUsername, { event: "comment_proposed" });
            logActivity({
              stage: "threads_comment_queued",
              text: comment.slice(0, 60),
              postId: post.id || null,
              author: post.authorUsername,
            });
            commentProposedThisSession += 1;
            actionsPerformed += 1;
          }
        }

        await randomDelay(180000, 600000, page);
      }

      if (actionsPerformed >= THREADS_MAX_ACTIONS_PER_SESSION) {
        break;
      }
    }

    if (!posts.length) {
      break;
    }
  }

  const sessionDurationMs = Date.now() - startedAt;

  // Record thematic observation from this session (for conversation injection)
  const resonantDecisions = decisions.filter((d) => d.emotionalResonance >= 0.6 && d.emotionDetected);
  if (resonantDecisions.length > 0) {
    const emotionCounts = {};
    resonantDecisions.forEach((d) => {
      const e = d.emotionDetected || "neutral";
      emotionCounts[e] = (emotionCounts[e] || 0) + 1;
    });
    const topEmotions = Object.entries(emotionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([e]) => e);
    const summary = `今天滑了 ${decisions.length} 則，有感覺的 ${resonantDecisions.length} 則，主要情緒：${topEmotions.join("、")}`;
    recordObservation({ summary, themes: topEmotions, postCount: decisions.length });
  }

  logActivity({
    stage: "threads_session_end",
    text: `滑文結束：按讚 ${actionsPerformed} 次，留言提議 ${commentProposedThisSession} 次，共看 ${decisions.length} 則`,
    actionsPerformed,
    commentProposed: commentProposedThisSession,
    postsEvaluated: decisions.length,
    durationMs: sessionDurationMs,
  });
  return {
    success: true,
    actionsPerformed,
    decisions,
    sessionDurationMs,
    blocked: false,
  };
}

async function runSmoke() {
  const page = await getNamedPage("main");
  console.log("[THREADS EXECUTOR] smoke start");
  await page.waitForTimeout(5000);
  console.log("[THREADS EXECUTOR] smoke success");
  return {
    success: true,
    profilePath: "threads_profile",
    currentUrl: page.url(),
  };
}

async function runAutonomousSession() {
  const page = await getNamedPage("main");
  console.log("[THREADS EXECUTOR] autonomous session start");
  return autonomousSession(page);
}

async function executeAction(action) {
  const page = await getNamedPage("main");

  console.log(`[THREADS EXECUTOR] ${String(action.action || "unknown").toUpperCase()} post ${action.targetPostId || "unknown"}`);
  if (action.targetUrl) {
    console.log(`[THREADS EXECUTOR] goto target ${action.targetUrl}`);
    await page.goto(action.targetUrl, { waitUntil: "domcontentloaded" });
  }

  if (action.action === "like") {
    console.log("[THREADS EXECUTOR] try like selectors");
    const clicked = await clickFirst(page, [
      '[aria-label*="Like"]',
      '[data-testid="like"]',
      'svg[aria-label*="Like"]',
    ]);
    if (clicked) {
      markThreadsActionExecuted();
    }
    return { success: clicked, action: "like", targetPostId: action.targetPostId || null };
  }

  if (action.action === "reply") {
    console.log("[THREADS EXECUTOR] try open reply composer");
    const opened = await clickFirst(page, [
      '[aria-label*="Reply"]',
      '[data-testid="reply"]',
      'svg[aria-label*="Reply"]',
    ]);
    if (!opened) {
      return { success: false, action: "reply", error: "reply composer not found" };
    }

    const textArea = page.locator('textarea, div[contenteditable="true"]').first();
    if (!await textArea.count()) {
      return { success: false, action: "reply", error: "reply input not found" };
    }

    console.log("[THREADS EXECUTOR] fill reply content");
    await textArea.fill(action.content || "");
    console.log("[THREADS EXECUTOR] submit reply");
    const submitted = await clickFirst(page, [
      'button:has-text("Post")',
      'button:has-text("Reply")',
    ]);
    if (submitted) {
      logActivity({
        stage: "threads_reply",
        text: `留言：${String(action.content || "").slice(0, 80)}`,
        postId: action.targetPostId || null,
        targetUrl: action.targetUrl || null,
        author: action.user_id || null,
      });
      // Closed loop: mark comment as executed in impression store
      const authorUsername = action.user_id || action.username || null;
      if (authorUsername) {
        updateImpression(authorUsername, { event: "comment_executed" });
      }
    }
    return {
      success: submitted,
      action: "reply",
      content: action.content || "",
      targetPostId: action.targetPostId || null,
    };
  }

  return { success: false, action: action.action, error: "unsupported action" };
}

module.exports = {
  executeAction,
  runSmoke,
  runAutonomousSession,
  autonomousSession,
  humanLikeScroll,
  aiEvaluate,
  THREADS_MAX_ACTIONS_PER_SESSION,
  THREADS_SESSION_DURATION_LIMIT,
};
