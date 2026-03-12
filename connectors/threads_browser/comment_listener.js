const fs = require("fs");
const path = require("path");
const { emitIncomingEvent } = require("../../core/event_bus");
const { hasSelfPost } = require("./self_posts_store");
const { markProcessed } = require("../../utils/threads_processed_store");

const eventsLogPath = path.join(__dirname, "../../logs/events.log");

function appendEventLog(entry) {
  fs.mkdirSync(path.dirname(eventsLogPath), { recursive: true });
  fs.appendFileSync(
    eventsLogPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
  );
}

function extractUsernameFromUrl(url = "") {
  const match = String(url).match(/\/@([^/?#]+)/i);
  return match ? match[1] : null;
}

function normalizeComment(comment = {}) {
  const postUrl = comment.postUrl || comment.url || null;
  return {
    id: comment.id || null,
    postId: comment.postId || null,
    postOwnerId: comment.postOwnerId || comment.postAuthorId || null,
    postAuthorUsername:
      comment.postAuthorUsername
      || comment.postUsername
      || extractUsernameFromUrl(postUrl)
      || null,
    postUrl,
    postText: String(comment.postText || comment.originalPost?.content || ""),
    authorId: comment.authorId || null,
    authorUsername: comment.authorUsername || comment.username || null,
    text: String(comment.text || comment.content || ""),
    timestamp: comment.timestamp || new Date().toISOString(),
  };
}

function handleIncomingThreadComment(comment = {}, options = {}) {
  const normalized = normalizeComment(comment);
  const isOwnPost = hasSelfPost(normalized.postId)
    || String(normalized.postOwnerId || "") === "self";

  appendEventLog({
    kind: "threads_comment_inbound",
    commentId: normalized.id,
    postId: normalized.postId,
    authorId: normalized.authorId,
    isOwnPost,
  });

  const scheduled = emitIncomingEvent(
    {
      type: "comment",
      prioritySource: "threads",
      platform: "threads",
      connector: "threads_browser",
      channel: "public",
      chatType: "public",
      interactionSource: isOwnPost ? null : "external_reply",
      postId: normalized.postId,
      postAuthorId: isOwnPost ? "self" : (normalized.postOwnerId || "external"),
      userId: normalized.authorId,
      username: normalized.authorUsername,
      authorUsername: normalized.authorUsername,
      text: normalized.text,
      content: normalized.text,
      commentId: normalized.id,
      originalPost: {
        postId: normalized.postId,
        authorUsername: normalized.postAuthorUsername,
        content: normalized.postText,
        url: normalized.postUrl,
      },
      originalComment: {
        commentId: normalized.id,
        username: normalized.authorUsername,
        content: normalized.text,
      },
      postOwnerId: isOwnPost ? "self" : (normalized.postOwnerId || "external"),
      timestamp: normalized.timestamp,
    },
    {
      selfId: "self",
      skipCooldown: Boolean(options.skipCooldown),
    },
  );

  appendEventLog({
    kind: "threads_comment_emitted",
    emitted: Boolean(scheduled),
    normalizedType: scheduled?.type || null,
    postId: normalized.postId,
    commentId: normalized.id,
    userId: normalized.authorId,
  });

  if (scheduled) {
    markProcessed(normalized.id);
  }

  return {
    emitted: Boolean(scheduled),
    event: scheduled || null,
    comment: normalized,
    isOwnPost,
  };
}

module.exports = {
  handleIncomingThreadComment,
};
