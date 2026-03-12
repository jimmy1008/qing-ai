const { scheduler } = require("./priority_scheduler");

function classifyPriorityEvent(event = {}, selfId = null) {
  if (!event) return null;

  if (event.type === "dm" || event.type === "private_message" || event.channel === "private") {
    return "NEW_DM";
  }

  if (event.type === "mention" || event.mentionDetected === true) {
    return "MENTION";
  }

  if (event.type === "comment" && selfId && String(event.postAuthorId) === String(selfId)) {
    return "NEW_COMMENT_ON_OWN_POST";
  }

  if (event.type === "comment" && selfId && String(event.postAuthorId) !== String(selfId)) {
    return "NEW_COMMENT_ON_EXTERNAL_POST";
  }

  if (event.type === "comment" || event.type === "feed_post" || event.type === "new_post") {
    return "NEW_POST_IN_FEED";
  }

  return null;
}

function emitIncomingEvent(event = {}, options = {}) {
  const normalizedType = classifyPriorityEvent(event, options.selfId || event.selfId || null);
  if (!normalizedType) return null;

  return scheduler.enqueue(
    {
      ...event,
      type: normalizedType,
    },
    options,
  );
}

module.exports = {
  classifyPriorityEvent,
  emitIncomingEvent,
};
